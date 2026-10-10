import type { EmailSummary, GmailLabel, GmailTokens } from './types';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/**
 * Applique `fn` à chaque élément avec une concurrence limitée.
 * Préserve l'ordre du tableau d'entrée. Les erreurs remontent à l'appelant
 * (utiliser `fn` qui catch en interne pour ignorer les éléments fautifs).
 */
export async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

function b64urlDecode(input: string): string {
  // Gmail renvoie du base64url sans padding.
  const cleaned = input.replace(/\s+/g, '');
  const padded = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4);
  try {
    const buf = Buffer.from(padded, 'base64url');
    let text = buf.toString('utf8');
    // Nettoie les caractères de contrôle et normalise les espaces.
    text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
    return text;
  } catch {
    return '';
  }
}

/** Nettoie un snippet Gmail pour l'affichage. */
function cleanSnippet(s: string): string {
  if (!s) return '';
  // Retire les espaces multiples et les retours à la ligne.
  return s.replace(/\s+/g, ' ').trim().slice(0, 200);
}

interface Header { name: string; value: string; }
interface Body { data?: string | null; }
interface Part { mimeType?: string | null; body?: Body | null; parts?: Part[] | null; }
interface Payload { headers?: Header[]; parts?: Part[] | null; body?: Body | null; mimeType?: string | null; }
interface MessageFull {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  payload?: Payload | null;
  internalDate?: string;
}
interface MessageRef { id: string; threadId: string; }
interface MessageList { messages: MessageRef[]; nextPageToken?: string | null; }
interface LabelList { labels: GmailLabel[]; }

function header(headers: Header[] | undefined, name: string): string {
  if (!headers) return '';
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function extractText(payload: Payload | null | undefined): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return b64urlDecode(payload.body.data);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const t = extractText(part);
      if (t) return t;
    }
  }
  if (payload.body?.data) {
    return b64urlDecode(payload.body.data);
  }
  return '';
}

export class GmailClient {
  private accessToken: string;
  /** Signal d'annulation optionnel : les appels en vol s'interrompent. */
  private signal?: AbortSignal;

  constructor(tokens: GmailTokens, signal?: AbortSignal) {
    this.accessToken = tokens.accessToken;
    this.signal = signal;
  }

  /**
   * Requête Gmail avec retry automatique (3 tentatives, backoff exponentiel).
   * Gère les erreurs réseau, 503, et rate limit Gmail.
   */
  private async request(path: string, init: RequestInit = {}, query?: Record<string, string | string[]>): Promise<string> {
    let qs = '';
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (Array.isArray(v)) {
          for (const item of v) params.append(k, item);
        } else {
          params.set(k, v);
        }
      }
      qs = '?' + params.toString();
    }
    const url = `${GMAIL_API}${path}${qs}`;
    const maxRetries = 3;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Timeout 30s + signal d'annulation du tri : une connexion Gmail
        // bloquée ne doit jamais geler un worker, et « Arrêter » doit
        // couper aussi les requêtes en vol (flush, métadonnées).
        const signals = [AbortSignal.timeout(30_000), ...(this.signal ? [this.signal] : [])];
        const resp = await fetch(url, {
          ...init,
          signal: AbortSignal.any(signals),
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            ...(init.headers ?? {}),
          },
        });
        const text = await resp.text();

        if (resp.ok) return text;

        // 429 = rate limit Gmail ; 403 avec « quota » = coût de requêtes
        // par minute dépassé → même traitement : backoff et retry.
        const quota403 = resp.status === 403 && /quota|rate.?limit/i.test(text);
        if ((resp.status === 429 || quota403) && attempt < maxRetries) {
          const backoff = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
          console.warn(`[Gmail] ${path} ${resp.status} quota — retry ${attempt + 1}/${maxRetries} dans ${backoff}ms`);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }

        // 503 = service unavailable → retry.
        if (resp.status >= 500 && attempt < maxRetries) {
          const backoff = 500 * Math.pow(2, attempt);
          console.warn(`[Gmail] ${path} ${resp.status} — retry ${attempt + 1}/${maxRetries} dans ${backoff}ms`);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }

        // 401 = token expiré → erreur spécifique pour que ipc.ts puisse refresh.
        if (resp.status === 401) {
          throw new Error(`Gmail ${path} 401: Token expiré — reconnexion nécessaire`);
        }

        // Autre erreur → pas de retry.
        throw new Error(`Gmail ${path} ${resp.status}: ${text.slice(0, 200)}`);
      } catch (e) {
        // Erreur réseau ou timeout → retry.
        const isNetErr = e instanceof TypeError || (e instanceof DOMException && e.name === 'TimeoutError');
        if (isNetErr && attempt < maxRetries) {
          const backoff = 500 * Math.pow(2, attempt);
          console.warn(`[Gmail] ${path} ${e instanceof DOMException ? 'timeout' : 'réseau'} — retry ${attempt + 1}/${maxRetries} dans ${backoff}ms`);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        throw e;
      }
    }
    throw new Error(`Gmail ${path} : échec après ${maxRetries} tentatives`);
  }

  /**
   * Liste les mails de la boîte de réception avec pagination.
   * Gmail limite maxResults à 500 par requête ; on boucle jusqu'à atteindre `max`.
   * Si max <= 0, récupère TOUS les mails.
   */
  async listInbox(max: number): Promise<MessageRef[]> {
    const all: MessageRef[] = [];
    let pageToken: string | null = null;
    const perPage = 500; // maximum accepté par l'API Gmail

    do {
      const query: Record<string, string> = {
        labelIds: 'INBOX',
        maxResults: String(max > 0 && max - all.length < perPage ? max - all.length : perPage),
      };
      if (pageToken) query.pageToken = pageToken;

      const text = await this.request('/messages', {}, query);
      const v: MessageList = JSON.parse(text);
      if (v.messages) all.push(...v.messages);
      pageToken = v.nextPageToken ?? null;

      // Arrêt si on a atteint le max demandé, ou s'il n'y a plus de pages.
      if (max > 0 && all.length >= max) break;
    } while (pageToken);

    // Tronque si on a dépassé le max demandé.
    if (max > 0 && all.length > max) all.length = max;
    return all;
  }

  async getMessage(id: string): Promise<EmailSummary & { labelIds: string[]; bodyText: string }> {
    const text = await this.request(`/messages/${id}`, {}, { format: 'full' });
    const m: MessageFull = JSON.parse(text);
    const headers = m.payload?.headers ?? [];
    const bodyText = extractText(m.payload);
    const snippet = cleanSnippet(m.snippet || bodyText.slice(0, 200));
    const isStarred = m.labelIds.includes('STARRED');
    return {
      id: m.id,
      threadId: m.threadId,
      from: header(headers, 'From'),
      to: header(headers, 'To'),
      subject: header(headers, 'Subject'),
      snippet,
      date: header(headers, 'Date'),
      unread: m.labelIds.includes('UNREAD'),
      starred: isStarred,
      category: isStarred ? 'favoris' : null,
      appliedLabel: null,
      labelIds: m.labelIds ?? [],
      bodyText,
    };
  }

  /**
   * Version légère de getMessage : utilise format=metadata (headers seulement,
   * pas de body). 5-10x plus rapide que format=full. Utilisé pour listEmails.
   */
  async getMessageMetadata(id: string): Promise<EmailSummary & { labelIds: string[] }> {
    const text = await this.request(`/messages/${id}`, {}, { format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] });
    const m: MessageFull = JSON.parse(text);
    const headers = m.payload?.headers ?? [];
    const isStarred = m.labelIds.includes('STARRED');
    return {
      id: m.id,
      threadId: m.threadId,
      from: header(headers, 'From'),
      to: header(headers, 'To'),
      subject: header(headers, 'Subject'),
      snippet: cleanSnippet(m.snippet || ''),
      date: header(headers, 'Date'),
      unread: m.labelIds.includes('UNREAD'),
      starred: isStarred,
      category: isStarred ? 'favoris' : null,
      appliedLabel: null,
      labelIds: m.labelIds ?? [],
    };
  }

  /**
   * Récupère uniquement le body text d'un message (utilisé pendant le tri
   * si on a déjà les metadata via getMessageMetadata).
   */
  async getMessageBody(id: string): Promise<string> {
    const text = await this.request(`/messages/${id}`, {}, { format: 'full' });
    const m: MessageFull = JSON.parse(text);
    return extractText(m.payload);
  }

  async listLabels(): Promise<GmailLabel[]> {
    const text = await this.request('/labels');
    const v: LabelList = JSON.parse(text);
    return v.labels ?? [];
  }

  async createLabel(name: string): Promise<GmailLabel> {
    const text = await this.request('/labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      }),
    });
    return JSON.parse(text);
  }

  async ensureLabel(name: string): Promise<string> {
    const labels = await this.listLabels();
    const found = labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (found) return found.id;
    const created = await this.createLabel(name);
    return created.id;
  }

  async applyLabel(messageId: string, labelId: string, archive: boolean): Promise<void> {
    const addLabelIds = [labelId];
    const removeLabelIds = archive ? ['INBOX'] : [];
    await this.request(`/messages/${messageId}/modify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addLabelIds, removeLabelIds }),
    });
  }

  /**
   * Applique un label à plusieurs messages via l'endpoint natif
   * `messages/batchModify` (1 seule requête HTTP jusqu'à 1000 ids).
   * Retourne les ids pour lesquels la modification a échoué.
   */
  async applyLabelBatch(messageIds: string[], labelId: string, archive: boolean): Promise<string[]> {
    const failed: string[] = [];
    const removeLabelIds = archive ? ['INBOX'] : [];
    // batchModify accepte max 1000 ids par appel.
    for (let i = 0; i < messageIds.length; i += 1000) {
      const ids = messageIds.slice(i, i + 1000);
      try {
        await this.request('/messages/batchModify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids, addLabelIds: [labelId], removeLabelIds }),
        });
      } catch (e) {
        console.warn('[Gmail] batchModify échoué — fallback unitaire pour', ids.length, 'mails:', e);
        // Fallback : modification message par message (4 en parallèle).
        const results = await mapPool(ids, 4, async (id) => {
          try {
            await this.request(`/messages/${id}/modify`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ addLabelIds: [labelId], removeLabelIds }),
            });
            return null;
          } catch (e2) {
            console.warn('[Gmail] modify échoué pour', id, e2);
            return id;
          }
        });
        failed.push(...results.filter((r): r is string => r !== null));
      }
    }
    return failed;
  }
}
