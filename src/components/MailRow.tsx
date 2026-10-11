import type { CSSProperties } from "react";
import type { Category, CategorizationResult, EmailSummary } from "../types";
import { categoryColor, formatDate, senderAddress, senderName } from "../utils/format";
import { IconAlert, IconExternal, IconRefresh, IconStar } from "./icons";

interface Props {
  mail: EmailSummary;
  result?: CategorizationResult;
  error?: string;
  retry?: { attempt: number; maxRetries: number };
  categories: Category[];
  onOpenInGmail: (id: string) => void;
}

/** Une ligne de mail : expéditeur, sujet, extrait, résultat du tri. */
export default function MailRow({ mail, result, error, retry, categories, onOpenInGmail }: Props) {
  const color = result ? categoryColor(result.categoryId, categories) : undefined;

  return (
    <li className={`mail ${mail.unread ? "unread" : ""} ${error ? "failed" : ""} ${retry ? "retrying" : ""}`}>
      <div className="mail-main">
        <div className="mail-topline">
          <span className="mail-from" title={senderAddress(mail.from)}>
            {mail.starred && <IconStar size={13} className="star" />}
            {senderName(mail.from) || "(expéditeur inconnu)"}
          </span>
          <span className="mail-date">{formatDate(mail.date)}</span>
        </div>
        <div className="mail-subject">{mail.subject || "(sans objet)"}</div>
        <div className="mail-snippet">{mail.snippet}</div>

        <div className="mail-foot">
          {mail.starred && (
            <span className="cat-pill" style={{ "--c": "#facc15" } as CSSProperties}>
              <i className="cat-dot" />
              Favoris
              <em>protégé</em>
            </span>
          )}
          {!mail.starred && result && (
            <span
              className="cat-pill"
              style={{ "--c": color } as CSSProperties}
              title={`Confiance ${Math.round(result.confidence * 100)}% — ${result.reason}`}
            >
              <i className="cat-dot" />
              {result.categoryName}
              <span className="conf-track" aria-hidden="true">
                <i style={{ width: `${Math.round(result.confidence * 100)}%` }} />
              </span>
              {result.archived && <em>archivé</em>}
            </span>
          )}
          {!mail.starred && result?.reason && (
            <span className="reason">{result.reason}</span>
          )}
          {error && (
            <span className="mail-error" title={error}>
              <IconAlert size={12} /> Échec
            </span>
          )}
          {retry && !error && (
            <span className="mail-retry" title="Ré-enfilé sur un autre modèle après échec">
              <IconRefresh size={12} /> À réessayer {retry.attempt}/{retry.maxRetries}
            </span>
          )}
        </div>
      </div>

      <button
        className="ghost icon-btn mail-open"
        onClick={() => onOpenInGmail(mail.id)}
        title="Ouvrir dans Gmail"
        aria-label="Ouvrir dans Gmail"
      >
        <IconExternal size={14} />
      </button>
    </li>
  );
}
