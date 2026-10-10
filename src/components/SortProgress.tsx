import type { SortProgress } from "../types";
import { providerName, shortModel } from "../utils/format";
import { IconStop, IconZap } from "./icons";

export interface ProviderHealth {
  ok: number;
  fail: number;
  lastLatencyMs: number;
  /** Dernier modèle utilisé par ce provider (rotation). */
  model: string | null;
}

interface Props {
  progress: SortProgress;
  health: Record<string, ProviderHealth>;
}

/** Barre de progression du tri + puces de santé live par provider. */
export default function SortProgressBar({ progress, health }: Props) {
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  let eta: string | null = null;
  if (progress.startedAt && progress.done > 0) {
    const elapsed = (Date.now() - progress.startedAt) / 1000;
    const rate = progress.done / elapsed;
    const remaining = progress.total - progress.done;
    const sec = rate > 0 ? Math.round(remaining / rate) : 0;
    eta = `${Math.floor(sec / 60)}m${sec % 60}s · ${rate.toFixed(1)}/s`;
  }

  return (
    <div className="sort-panel">
      <div className="sort-panel-head">
        <span className="sort-title">
          <IconZap size={14} />
          Tri en cours — {progress.done}/{progress.total}
          <span className="sort-pct">{pct}%</span>
        </span>
        <span className="sort-stats">
          <span className="ok">✓ {progress.succeeded}</span>
          {progress.failed > 0 && <span className="ko">✗ {progress.failed}</span>}
          {progress.skipped > 0 && <span className="skip">⊘ {progress.skipped} ignoré(s)</span>}
          {eta && <span className="eta">ETA {eta}</span>}
        </span>
      </div>

      <div
        className="sort-track"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Progression du tri"
      >
        <div className="sort-fill" style={{ width: `${pct}%` }} />
      </div>

      {(Object.keys(health).length > 0 || progress.lastCategory) && (
        <div className="sort-panel-foot">
          <div className="provider-chips">
            {Object.entries(health).map(([id, h]) => (
              <span
                key={id}
                className={`p-chip p-${id} ${h.fail > 0 && h.ok === 0 ? "down" : ""}`}
                title={`${h.ok} succès · ${h.fail} échecs${h.model ? ` · ${h.model}` : ""}`}
              >
                <i className="p-dot" />
                {providerName(id)}
                {h.model && <span className="p-model">{shortModel(h.model)}</span>}
                <span className="p-lat">{Math.round(h.lastLatencyMs)}ms</span>
              </span>
            ))}
          </div>
          {progress.lastCategory && <span className="last-cat">Dernier : {progress.lastCategory}</span>}
        </div>
      )}
    </div>
  );
}

export function StopButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="danger" onClick={onClick}>
      <IconStop size={13} /> Arrêter
    </button>
  );
}
