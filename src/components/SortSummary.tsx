import type { Category, CategorizationResult } from "../types";
import { categoryColor } from "../utils/format";
import { IconCheck, IconX } from "./icons";

interface Props {
  results: CategorizationResult[];
  total: number;
  categories: Category[];
  onDismiss: () => void;
}

/** Récapitulatif post-tri : répartition par catégorie en barres colorées. */
export default function SortSummary({ results, total, categories, onDismiss }: Props) {
  const counts = new Map<string, { name: string; n: number }>();
  for (const r of results) {
    const e = counts.get(r.categoryId);
    if (e) e.n++;
    else counts.set(r.categoryId, { name: r.categoryName, n: 1 });
  }
  const rows = [...counts.entries()].sort((a, b) => b[1].n - a[1].n);
  const max = rows.length > 0 ? rows[0][1].n : 1;

  return (
    <div className="summary-panel" role="status">
      <div className="summary-head">
        <span className="summary-title">
          <IconCheck size={15} /> Tri terminé — {results.length}/{total} mail(s) catégorisé(s)
        </span>
        <button className="ghost sm" onClick={onDismiss} aria-label="Fermer le résumé">
          <IconX size={14} />
        </button>
      </div>
      <div className="summary-rows">
        {rows.map(([id, { name, n }]) => {
          const color = categoryColor(id, categories);
          return (
            <div key={id} className="summary-row">
              <span className="summary-name">
                <i className="cat-dot" style={{ background: color }} />
                {name}
              </span>
              <span className="summary-track">
                <span
                  className="summary-bar"
                  style={{ width: `${Math.max(4, (n / max) * 100)}%`, background: color }}
                />
              </span>
              <span className="summary-count">{n}</span>
            </div>
          );
        })}
        {rows.length === 0 && <p className="summary-empty">Aucun mail n'a nécessité de tri.</p>}
      </div>
    </div>
  );
}
