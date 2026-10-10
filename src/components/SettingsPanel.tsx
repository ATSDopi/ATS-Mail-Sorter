import { useEffect, useState } from "react";
import type { AiProvider, Category, ProviderTestResult, Settings } from "../types";
import { api } from "../types";
import { PROVIDERS } from "../utils/format";
import {
  IconEye, IconEyeOff, IconExternal, IconFlask, IconPlus,
  IconShield, IconTrash,
} from "./icons";

interface Props {
  settings: Settings;
  onSave: (s: Settings) => void;
  /** Recharge les settings après la re-découverte des modèles. */
  onRefresh: () => void;
}

export default function SettingsPanel({ settings, onSave, onRefresh }: Props) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [testing, setTesting] = useState<Partial<Record<AiProvider, boolean>>>({});
  const [testResults, setTestResults] = useState<Partial<Record<AiProvider, ProviderTestResult>>>({});
  const [discovering, setDiscovering] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setDraft(settings);
    setDirty(false);
  }, [settings]);

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
  };

  const updateCategory = (idx: number, patch: Partial<Category>) => {
    setDraft((d) => {
      const cats = [...d.categories];
      cats[idx] = { ...cats[idx], ...patch };
      return { ...d, categories: cats };
    });
    setDirty(true);
  };

  const addCategory = () => {
    setDraft((d) => ({
      ...d,
      categories: [
        ...d.categories,
        { id: `cat-${Date.now()}`, name: "Nouvelle catégorie", gmailLabel: null, archiveAfter: false },
      ],
    }));
    setDirty(true);
  };

  const removeCategory = (idx: number) => {
    setDraft((d) => ({ ...d, categories: d.categories.filter((_, i) => i !== idx) }));
    setDirty(true);
  };

  const toggleReveal = (field: string) =>
    setReveal((r) => ({ ...r, [field]: !r[field] }));

  const testProvider = async (provider: AiProvider) => {
    setTesting((t) => ({ ...t, [provider]: true }));
    setTestResults((r) => ({ ...r, [provider]: undefined }));
    try {
      const res = await api.providers.test(provider);
      setTestResults((r) => ({ ...r, [provider]: res }));
    } catch (e) {
      setTestResults((r) => ({
        ...r,
        [provider]: { provider, model: null, ok: false, latencyMs: 0, error: String(e) },
      }));
    } finally {
      setTesting((t) => ({ ...t, [provider]: false }));
    }
  };

  return (
    <div className="settings">
      <section>
        <h2>Connexion Gmail (OAuth)</h2>
        <p className="help">
          Créez un projet sur <strong>Google Cloud Console</strong>, activez l'API Gmail,
          puis créez un identifiant OAuth 2.0 de type <em>Application de bureau</em>.
          Ajoutez <code>http://localhost:{draft.oauthRedirectPort}</code> dans les URI de redirection.
        </p>
        <div className="field-grid">
          <label>
            Client ID
            <input
              type="text"
              value={draft.googleClientId ?? ""}
              onChange={(e) => update("googleClientId", e.target.value || null)}
              placeholder="xxxxx.apps.googleusercontent.com"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label>
            Client Secret
            <span className="key-input">
              <input
                type={reveal.googleClientSecret ? "text" : "password"}
                value={draft.googleClientSecret ?? ""}
                onChange={(e) => update("googleClientSecret", e.target.value || null)}
                placeholder="GOCSPX-…"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="ghost icon-btn"
                onClick={() => toggleReveal("googleClientSecret")}
                aria-label={reveal.googleClientSecret ? "Masquer le secret" : "Afficher le secret"}
              >
                {reveal.googleClientSecret ? <IconEyeOff size={14} /> : <IconEye size={14} />}
              </button>
            </span>
          </label>
          <label>
            Port de redirection OAuth
            <input
              type="number"
              min={1024}
              max={65535}
              value={draft.oauthRedirectPort}
              onChange={(e) => update("oauthRedirectPort", Number(e.target.value) || 14250)}
            />
          </label>
        </div>
      </section>

      <section>
        <h2>Fournisseurs IA</h2>
        <p className="help">
          Renseignez au moins une clé — toutes gratuites. Le failover est automatique :
          un provider rate-limité est mis en pause et l'app bascule instantanément.
          Au save, l'<strong>auto-discovery</strong> valide le meilleur modèle de chaque clé.
        </p>

        <div className="provider-grid">
          {PROVIDERS.map((p) => {
            const key = draft[p.keyField];
            const modelEntry = settings.providerModels?.[p.id];
            const hasEntry = settings.providerModels && p.id in settings.providerModels;
            const queue = settings.providerModelQueue?.[p.id] ?? [];
            const test = testResults[p.id];
            return (
              <div key={p.id} className={`provider-card ${key ? "configured" : ""}`}>
                <div className="provider-card-head">
                  <i className={`p-dot p-${p.id}`} />
                  <div className="provider-title">
                    <strong>{p.name}</strong>
                    <small>{p.hint}</small>
                  </div>
                  <a
                    className="ghost icon-btn"
                    href={p.keyUrl}
                    target="_blank"
                    rel="noreferrer"
                    title={`Obtenir une clé ${p.name}`}
                    aria-label={`Obtenir une clé ${p.name}`}
                  >
                    <IconExternal size={13} />
                  </a>
                </div>

                <div className="key-row">
                  <span className="key-input">
                    <input
                      type={reveal[p.keyField] ? "text" : "password"}
                      value={key ?? ""}
                      onChange={(e) => update(p.keyField, e.target.value || null)}
                      placeholder={p.placeholder}
                      autoComplete="off"
                      spellCheck={false}
                      aria-label={`Clé API ${p.name}`}
                    />
                    <button
                      type="button"
                      className="ghost icon-btn"
                      onClick={() => toggleReveal(p.keyField)}
                      aria-label={reveal[p.keyField] ? "Masquer la clé" : "Afficher la clé"}
                    >
                      {reveal[p.keyField] ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                    </button>
                  </span>
                  <button
                    type="button"
                    className="ghost sm test-btn"
                    disabled={!key || testing[p.id]}
                    onClick={() => testProvider(p.id)}
                    title="Tester la clé enregistrée"
                  >
                    <IconFlask size={13} />
                    {testing[p.id] ? "…" : "Tester"}
                  </button>
                </div>

                <div className="provider-card-foot">
                  {test ? (
                    <span className={`model-tag ${test.ok ? "ok" : "ko"}`}>
                      {test.ok
                        ? `✓ ${test.model ?? "?"} · ${Math.round(test.latencyMs)}ms`
                        : `✗ ${test.error ?? "échec"}`}
                    </span>
                  ) : hasEntry ? (
                    modelEntry ? (
                      <span
                        className="model-tag ok"
                        title={queue.length > 0 ? `Rotation : ${[modelEntry, ...queue].join(' → ')}` : 'Modèle auto-découvert'}
                      >
                        ✓ {modelEntry}
                        {queue.length > 0 && <span className="queue-count"> +{queue.length} en réserve</span>}
                      </span>
                    ) : (
                      <span className="model-tag ko" title="Aucun modèle valide trouvé">
                        ✗ aucun modèle valide
                      </span>
                    )
                  ) : (
                    <span className="model-tag">
                      {key ? "non testé — discovery au save" : "clé manquante"}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <label className="batch-size">
          Taille du lot de chargement
          <input
            type="number"
            min={1}
            max={500}
            value={draft.batchSize}
            onChange={(e) => update("batchSize", Number(e.target.value) || 20)}
          />
        </label>
      </section>

      <section>
        <h2>Catégories</h2>
        <p className="help">
          Chaque catégorie crée ou réutilise un label Gmail du même nom (ou personnalisé).
          « Archiver » retire le mail de la boîte de réception après tri.
          <br />
          <strong className="star-text">★ Favoris</strong> est protégée : les mails étoilés ne sont
          jamais modifiés par l'IA.
        </p>
        <div className="categories">
          {draft.categories.map((c, i) => {
            const isProtected = c.id === "favoris";
            return (
              <div key={c.id} className={`category-row ${isProtected ? "protected" : ""}`}>
                <input
                  type="text"
                  value={c.name}
                  onChange={(e) => updateCategory(i, { name: e.target.value })}
                  placeholder="Nom"
                  disabled={isProtected}
                  aria-label="Nom de la catégorie"
                />
                <input
                  type="text"
                  value={c.gmailLabel ?? ""}
                  onChange={(e) => updateCategory(i, { gmailLabel: e.target.value || null })}
                  placeholder="Label Gmail (défaut = nom)"
                  disabled={isProtected}
                  aria-label="Label Gmail"
                />
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={c.archiveAfter}
                    onChange={(e) => updateCategory(i, { archiveAfter: e.target.checked })}
                    disabled={isProtected}
                  />
                  Archiver
                </label>
                {isProtected ? (
                  <span className="protected-tag" title="Catégorie protégée — non modifiable">
                    <IconShield size={12} /> Protégée
                  </span>
                ) : (
                  <button className="danger icon-btn" onClick={() => removeCategory(i)} aria-label="Supprimer la catégorie">
                    <IconTrash size={14} />
                  </button>
                )}
              </div>
            );
          })}
          <button className="add-cat" onClick={addCategory}>
            <IconPlus size={14} /> Ajouter une catégorie
          </button>
        </div>
      </section>

      <div className="settings-actions">
        <button
          className="ghost"
          disabled={discovering}
          title="Re-teste chaque clé et reconstruit les files de modèles (utile si les catalogues ont changé)"
          onClick={async () => {
            setDiscovering(true);
            try {
              await api.settings.discover();
              onRefresh();
            } finally {
              setDiscovering(false);
            }
          }}
        >
          <IconFlask size={14} /> {discovering ? "Découverte en cours…" : "Re-découvrir les modèles"}
        </button>
        {dirty && <span className="dirty-hint">Modifications non enregistrées</span>}
        <button className="primary" onClick={() => onSave(draft)}>Enregistrer</button>
      </div>
    </div>
  );
}
