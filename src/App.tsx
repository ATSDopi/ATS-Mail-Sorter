import { useCallback, useEffect, useState } from "react";
import type { CategorizationResult, EmailSummary, Settings, SortProgress } from "./types";
import { api } from "./types";
import EmailList from "./components/EmailList";
import SettingsPanel from "./components/SettingsPanel";
import DebugPanel from "./components/DebugPanel";
import Onboarding from "./components/Onboarding";
import SortSummary from "./components/SortSummary";
import ErrorBoundary from "./components/ErrorBoundary";
import type { ProviderHealth } from "./components/SortProgress";
import { IconAlert, IconInfo, IconMail, IconSparkles, IconX } from "./components/icons";

type Tab = "emails" | "settings" | "debug";

export default function App() {
  const [tab, setTab] = useState<Tab>("emails");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [emails, setEmails] = useState<EmailSummary[]>([]);
  const [loadingEmails, setLoadingEmails] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, CategorizationResult>>({});
  const [mailErrors, setMailErrors] = useState<Record<string, string>>({});
  const [mailRetries, setMailRetries] = useState<Record<string, { attempt: number; maxRetries: number }>>({});
  const [providerHealth, setProviderHealth] = useState<Record<string, ProviderHealth>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [sortProgress, setSortProgress] = useState<SortProgress | null>(null);
  const [dryRun, setDryRun] = useState(false);
  const [summary, setSummary] = useState<{ total: number } | null>(null);

  const loadSettings = useCallback(async () => {
    try {
      const s = await api.settings.get();
      setSettings(s);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // Auto-dismiss des messages d'info après 8s.
  useEffect(() => {
    if (!info) return;
    const t = setTimeout(() => setInfo(null), 8000);
    return () => clearTimeout(t);
  }, [info]);

  // Écouteurs d'événements de progression du tri (temps réel).
  useEffect(() => {
    const offStart = api.ai.onSortStart((data) => {
      setSortProgress({
        total: data.total, done: 0, succeeded: 0, failed: 0,
        skipped: 0, currentEmail: "", lastCategory: null,
      });
      setResults({});
      setMailErrors({});
      setMailRetries({});
      setProviderHealth({});
      setSummary(null);
    });
    const offProgress = api.ai.onSortProgress(setSortProgress);
    const offResult = api.ai.onSortResult((data) => {
      setResults((prev) => ({ ...prev, [data.emailId]: data }));
      setMailErrors((prev) => {
        if (!(data.emailId in prev)) return prev;
        const next = { ...prev };
        delete next[data.emailId];
        return next;
      });
      setMailRetries((prev) => {
        if (!(data.emailId in prev)) return prev;
        const next = { ...prev };
        delete next[data.emailId];
        return next;
      });
    });
    const offError = api.ai.onSortError((data) => {
      setMailErrors((prev) => ({ ...prev, [data.emailId]: data.error }));
      setMailRetries((prev) => {
        if (!(data.emailId in prev)) return prev;
        const next = { ...prev };
        delete next[data.emailId];
        return next;
      });
    });
    const offRetry = api.ai.onSortRetry((data) => {
      setMailRetries((prev) => ({ ...prev, [data.emailId]: { attempt: data.attempt, maxRetries: data.maxRetries } }));
      setMailErrors((prev) => {
        if (!(data.emailId in prev)) return prev;
        const next = { ...prev };
        delete next[data.emailId];
        return next;
      });
    });
    const offDone = api.ai.onSortDone((data) => {
      setSortProgress(null);
      setSummary({ total: data.total });
    });
    const offCancelled = api.ai.onSortCancelled((data) => {
      setSortProgress(null);
      setInfo(`Tri arrêté : ${data.done}/${data.total} mail(s) traité(s).`);
    });
    const offProvider = api.ai.onSortProvider((data) => {
      setProviderHealth((prev) => {
        const h = prev[data.provider] ?? { ok: 0, fail: 0, lastLatencyMs: 0, model: null };
        return {
          ...prev,
          [data.provider]: {
            ok: h.ok + (data.success ? 1 : 0),
            fail: h.fail + (data.success ? 0 : 1),
            lastLatencyMs: data.latencyMs,
            model: data.model ?? h.model,
          },
        };
      });
    });
    return () => {
      offStart(); offProgress(); offResult(); offError(); offRetry();
      offDone(); offCancelled(); offProvider();
    };
  }, []);

  const refreshEmails = useCallback(async () => {
    setError(null);
    setLoadingEmails(true);
    try {
      const list = await api.gmail.listEmails(settings?.batchSize ?? 20);
      setEmails(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingEmails(false);
    }
  }, [settings?.batchSize]);

  const handleConnect = useCallback(async () => {
    setError(null);
    setInfo(null);
    setBusy("connect");
    try {
      await api.gmail.connect();
      setInfo("Gmail connecté avec succès.");
      await loadSettings();
      await refreshEmails();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [loadSettings, refreshEmails]);

  const handleDisconnect = useCallback(async () => {
    setBusy("disconnect");
    try {
      await api.gmail.disconnect();
      setEmails([]);
      setResults({});
      setSummary(null);
      setInfo("Gmail déconnecté.");
      await loadSettings();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [loadSettings]);

  const handleLoadAll = useCallback(async () => {
    setError(null);
    setInfo(null);
    setLoadingEmails(true);
    try {
      const list = await api.gmail.listEmails(0);
      setEmails(list);
      setInfo(`${list.length} mail(s) chargé(s).`);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingEmails(false);
    }
  }, []);

  const handleCategorizeAll = useCallback(async () => {
    setError(null);
    setInfo(null);
    setBusy("batch");
    try {
      await api.ai.categorizeAll(dryRun);
      // Les résultats arrivent en temps réel via onSortResult/onSortDone.
    } catch (e) {
      setError(String(e));
      setSortProgress(null);
    } finally {
      setBusy(null);
    }
  }, [dryRun]);

  const handleCategorizeBatch = useCallback(async () => {
    setError(null);
    setInfo(null);
    setBusy("batch");
    try {
      await api.ai.categorizeBatch(undefined, dryRun);
    } catch (e) {
      setError(String(e));
      setSortProgress(null);
    } finally {
      setBusy(null);
    }
  }, [dryRun]);

  const handleCancelSort = useCallback(async () => {
    try {
      await api.ai.cancelSort();
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const handleOpenInGmail = useCallback(async (id: string) => {
    try {
      await api.gmail.openMessage(id);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const handleSaveSettings = useCallback(async (s: Settings) => {
    setError(null);
    try {
      const saved = await api.settings.save(s);
      setSettings(saved);
      setInfo("Paramètres enregistrés — vérification des modèles IA en arrière-plan.");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const connected = !!settings?.gmailTokens;
  const hasOauth = !!(settings?.googleClientId && settings?.googleClientSecret);
  const hasKey = !!(
    settings?.openrouterApiKey || settings?.nvidiaApiKey || settings?.groqApiKey ||
    settings?.geminiApiKey || settings?.sambanovaApiKey || settings?.cerebrasApiKey
  );
  const ready = hasOauth && hasKey && connected;

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">
            <IconMail size={17} />
            <IconSparkles size={11} className="brand-spark" />
          </span>
          <h1>Mail Sorter <span className="brand-ai">AI</span></h1>
        </div>

        <nav className="tabs" role="tablist">
          {(["emails", "settings", "debug"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`tab ${tab === t ? "active" : ""}`}
              onClick={() => setTab(t)}
            >
              {t === "emails" ? "Mails" : t === "settings" ? "Paramètres" : "Debug"}
            </button>
          ))}
        </nav>

        <div className="connection">
          {connected ? (
            <>
              <span className="badge ok">
                <span className="pulse-dot" />
                Gmail connecté
              </span>
              <button className="ghost" onClick={handleDisconnect} disabled={busy === "disconnect"}>
                {busy === "disconnect" ? "…" : "Déconnecter"}
              </button>
            </>
          ) : (
            <button className="primary" onClick={handleConnect} disabled={busy === "connect"}>
              {busy === "connect" ? "Connexion…" : "Connecter Gmail"}
            </button>
          )}
        </div>
      </header>

      {(error || info) && (
        <div className="alerts">
          {error && (
            <div className="alert error" role="alert">
              <IconAlert size={15} />
              <span>{error}</span>
              <button className="ghost icon-btn" onClick={() => setError(null)} aria-label="Fermer">
                <IconX size={13} />
              </button>
            </div>
          )}
          {info && (
            <div className="alert info" role="status">
              <IconInfo size={15} />
              <span>{info}</span>
              <button className="ghost icon-btn" onClick={() => setInfo(null)} aria-label="Fermer">
                <IconX size={13} />
              </button>
            </div>
          )}
        </div>
      )}

      <main className="app-main">
        {tab === "emails" && (
          <>
            {!ready && (
              <Onboarding
                settings={settings}
                connected={connected}
                connecting={busy === "connect"}
                onGoSettings={() => setTab("settings")}
                onConnect={handleConnect}
              />
            )}
            {connected && summary && (
              <SortSummary
                results={Object.values(results)}
                total={summary.total}
                categories={settings?.categories ?? []}
                onDismiss={() => setSummary(null)}
              />
            )}
            {connected && (
              <EmailList
                emails={emails}
                results={results}
                errors={mailErrors}
                retries={mailRetries}
                loading={loadingEmails}
                busy={busy}
                categories={settings?.categories ?? []}
                sortProgress={sortProgress}
                providerHealth={providerHealth}
                dryRun={dryRun}
                onRefresh={refreshEmails}
                onLoadAll={handleLoadAll}
                onCategorizeAll={handleCategorizeAll}
                onCategorizeBatch={handleCategorizeBatch}
                onCancelSort={handleCancelSort}
                onToggleDryRun={() => setDryRun(!dryRun)}
                onOpenInGmail={handleOpenInGmail}
              />
            )}
          </>
        )}

        {tab === "settings" && (
          <ErrorBoundary>
            {settings
              ? <SettingsPanel settings={settings} onSave={handleSaveSettings} onRefresh={loadSettings} />
              : <div className="loading">Chargement…</div>}
          </ErrorBoundary>
        )}

        {tab === "debug" && (
          <ErrorBoundary>
            <DebugPanel />
          </ErrorBoundary>
        )}
      </main>
    </div>
  );
}
