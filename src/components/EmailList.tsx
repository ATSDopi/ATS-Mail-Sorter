import type { Category, CategorizationResult, EmailSummary, SortProgress } from "../types";
import MailRow from "./MailRow";
import SortProgressBar, { type ProviderHealth } from "./SortProgress";
import { IconInbox, IconRefresh, IconZap } from "./icons";

interface Props {
  emails: EmailSummary[];
  results: Record<string, CategorizationResult>;
  errors: Record<string, string>;
  retries: Record<string, { attempt: number; maxRetries: number }>;
  loading: boolean;
  busy: string | null;
  categories: Category[];
  sortProgress: SortProgress | null;
  providerHealth: Record<string, ProviderHealth>;
  dryRun: boolean;
  onRefresh: () => void;
  onLoadAll: () => void;
  onCategorizeAll: () => void;
  onCategorizeBatch: () => void;
  onCancelSort: () => void;
  onToggleDryRun: () => void;
  onOpenInGmail: (id: string) => void;
}

export default function EmailList({
  emails, results, errors, retries, loading, busy, categories,
  sortProgress, providerHealth, dryRun,
  onRefresh, onLoadAll, onCategorizeAll, onCategorizeBatch,
  onCancelSort, onToggleDryRun, onOpenInGmail,
}: Props) {
  const sortedCount = Object.keys(results).length;
  const sorting = busy === "batch";

  return (
    <div className="email-list">
      <div className="toolbar">
        <button onClick={onRefresh} disabled={loading || busy !== null}>
          <IconRefresh size={14} />
          {loading ? "Chargement…" : "Rafraîchir"}
        </button>
        <button onClick={onLoadAll} disabled={loading || busy !== null}>
          <IconInbox size={14} />
          Tout charger
        </button>
        <span className="toolbar-sep" />
        <button
          onClick={onCategorizeBatch}
          disabled={sorting || loading}
          title="Trier seulement le lot de mails chargé (batchSize)"
        >
          <IconZap size={14} />
          {sorting ? "Tri en cours…" : "Trier le lot"}
        </button>
        <button
          className="primary"
          onClick={onCategorizeAll}
          disabled={sorting || loading}
          title="Trier toute la boîte de réception"
        >
          <IconZap size={14} />
          {sorting ? "Tri en cours…" : "Trier tout"}
        </button>
        <label className="checkbox dry-run-toggle" title="Catégorise sans déplacer les mails">
          <input
            type="checkbox"
            checked={dryRun}
            onChange={onToggleDryRun}
            disabled={sorting}
          />
          Dry run
        </label>
        {sorting && (
          <button className="danger" onClick={onCancelSort}>
            Arrêter
          </button>
        )}
        <span className="hint">
          {emails.length} affiché(s) · {sortedCount} trié(s)
        </span>
      </div>

      {sortProgress && <SortProgressBar progress={sortProgress} health={providerHealth} />}

      {emails.length === 0 && !loading && (
        <div className="empty">
          <IconInbox size={32} />
          <p>Aucun mail chargé.<br />Cliquez sur « Rafraîchir » ou « Tout charger ».</p>
        </div>
      )}

      <ul className="mails">
        {emails.map((m) => (
          <MailRow
            key={m.id}
            mail={m}
            result={results[m.id]}
            error={errors[m.id]}
            retry={retries[m.id]}
            categories={categories}
            onOpenInGmail={onOpenInGmail}
          />
        ))}
      </ul>
    </div>
  );
}
