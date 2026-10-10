import { useEffect, useState } from "react";
import { api } from "../types";
import { IconFlask, IconRefresh } from "./icons";

/** Onglet Debug : logs + stats providers en temps réel. */
export default function DebugPanel() {
  const [logs, setLogs] = useState("");
  const [stats, setStats] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [testResult, setTestResult] = useState("");
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const refresh = async () => {
      try {
        const [l, s] = await Promise.all([
          api.debug.getLogs(),
          api.debug.getProviderStats(),
        ]);
        if (!cancelled) {
          setLogs(l);
          setStats(s);
        }
      } catch (e) {
        if (!cancelled) setLogs(`Erreur: ${e}`);
      }
      if (autoRefresh && !cancelled) {
        timer = window.setTimeout(refresh, 2000);
      }
    };

    refresh();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [autoRefresh]);

  const runTest = async () => {
    setTesting(true);
    setTestResult("Test en cours…");
    try {
      const result = await api.debug.testProviders();
      setTestResult(result);
    } catch (e) {
      setTestResult(`Erreur: ${e}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="debug-panel">
      <div className="debug-header">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          Auto-refresh (2s)
        </label>
        <button className="ghost" onClick={() => { setAutoRefresh(false); setTimeout(() => setAutoRefresh(true), 50); }}>
          <IconRefresh size={13} /> Forcer refresh
        </button>
        <button className="primary" onClick={runTest} disabled={testing}>
          <IconFlask size={14} />
          {testing ? "Test en cours…" : "Tester les providers"}
        </button>
      </div>

      <section className="debug-section">
        <h3>Test des providers IA</h3>
        <pre className="debug-pre stats">{testResult || "Cliquez sur « Tester les providers » pour vérifier vos clés API."}</pre>
      </section>

      <section className="debug-section">
        <h3>Stats providers IA (temps réel)</h3>
        <pre className="debug-pre stats">{stats || "—"}</pre>
      </section>

      <section className="debug-section">
        <h3>Logs ({logs.split("\n").length} lignes)</h3>
        <pre className="debug-pre logs">{logs || "—"}</pre>
      </section>
    </div>
  );
}
