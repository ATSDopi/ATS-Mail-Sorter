import type { AiProvider, CategorizationOutput, Settings } from './types';

// URLs des 6 providers (tous compatibles OpenAI chat/completions).
const PROVIDER_URLS: Record<AiProvider, string> = {
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  nvidia: 'https://integrate.api.nvidia.com/v1/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  sambanova: 'https://api.sambanova.ai/v1/chat/completions',
  cerebras: 'https://api.cerebras.ai/v1/chat/completions',
};

// ─── Registre des providers ────────────────────────────────────────────
// Source unique de vérité : nom du champ Settings contenant la clé API.
// Tous les modules (ai, discovery, ipc) partagent ce mapping au lieu de
// dupliquer les 6 blocs `if (settings.xApiKey)` un peu partout.

export type ApiKeyField =
  | 'openrouterApiKey' | 'nvidiaApiKey' | 'groqApiKey'
  | 'geminiApiKey' | 'sambanovaApiKey' | 'cerebrasApiKey';

export const API_KEY_FIELD: Record<AiProvider, ApiKeyField> = {
  openrouter: 'openrouterApiKey',
  nvidia: 'nvidiaApiKey',
  groq: 'groqApiKey',
  gemini: 'geminiApiKey',
  sambanova: 'sambanovaApiKey',
  cerebras: 'cerebrasApiKey',
};

/** Liste ordonnée des 6 providers supportés. */
export const AI_PROVIDERS = Object.keys(API_KEY_FIELD) as AiProvider[];

/** Sous-ensemble de Settings nécessaire à l'init des providers. */
export type ProviderKeys = Pick<Settings, ApiKeyField | 'providerModels' | 'providerModelQueue'>;

/** Retourne la clé API d'un provider depuis les settings (null si absente). */
export function apiKeyFor(settings: ProviderKeys, provider: AiProvider): string | null {
  return settings[API_KEY_FIELD[provider]];
}

// Rate limits officiels (requests per minute, PAR MODÈLE pour Gemini/Groq).
// On reste sous la limite pour éviter les 429.
const PROVIDER_RPM: Record<AiProvider, number> = {
  openrouter: 20,
  nvidia: 40,
  groq: 30,
  gemini: 15,
  sambanova: 20,
  cerebras: 30,
};

// Modèles gratuits par défaut pour chaque provider (premier essayé).
// ATTENTION : ces catalogues évoluent vite — vérifiés contre les vraies
// API en oct. 2026. Un modèle qui meurt → ModelDeadError → rotation.
export const DEFAULT_MODELS: Record<AiProvider, string> = {
  openrouter: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  nvidia: 'google/gemma-4-31b-it',
  groq: 'openai/gpt-oss-120b',
  gemini: 'gemini-flash-lite-latest',
  sambanova: 'gemma-4-31B-it',
  cerebras: 'gpt-oss-120b',
};

// Modèles de secours curés par provider — utilisés en rotation quand le
// modèle principal est rate-limité ou à court de quota. Les modèles morts
// sont filtrés automatiquement au runtime (404/400 → retirés de la file),
// donc une entrée dépréciée ici n'est pas fatale.
export const CURATED_MODELS: Record<AiProvider, string[]> = {
  openrouter: [
    // Le free tier OpenRouter tourne constamment : les modèles `:free`
    // disponibles sont listés par /models — la discovery les trouve.
    'apodex/apodex-1.1-mini:free',
    'google/gemini-2.0-flash-exp:free',
  ],
  nvidia: [
    // Le catalogue NIM liste beaucoup de modèles mais le compte n'a
    // accès qu'à un sous-ensemble → les 404 « Function not found »
    // sont retirés par ModelDeadError.
    'deepseek-ai/deepseek-v4.1-flash',
    'google/gemma-3-12b-it',
    '01-ai/yi-large',
    'google/gemma-2b',
  ],
  groq: [
    'openai/gpt-oss-20b',
    'qwen/qwen3.8-27b',
    'allam-2-7b',
  ],
  gemini: [
    // Les alias -latest pointent toujours vers un modèle vivant.
    'gemini-flash-latest',
    'gemma-4-26b-a4b-it',
    'gemini-pro-latest',
    'gemma-4-31b-it',
  ],
  sambanova: [
    // Compte sans crédit : les modèles payants renvoient 402 → retirés.
    'MiniMax-M3',
    'DeepSeek-V3.2',
    'gpt-oss-120b',
  ],
  cerebras: [
    // Seuls ces 2 modèles sont exposés par la clé actuellement.
    'qwen-3.8-27b',
  ],
};

// --- Constantes d'orchestration ---

// Cooldown de base après un 429 (si pas de header Retry-After).
// Augmente exponentiellement : 20s, 40s, 80s… (max 5 min).
const BASE_COOLDOWN_MS = 20_000;
const MAX_COOLDOWN_MS = 5 * 60_000;

// Timeout d'une requête IA : 15s. Pour une catégorisation simple, c'est
// largement suffisant. Au-delà, le modèle est considéré lent → cooldown
// court et on bascule sur le suivant.
const REQUEST_TIMEOUT_MS = 15_000;

// Fenêtre glissante pour le suivi du RPM (60s), PAR MODÈLE : les quotas
// gratuits de Gemini/Groq sont par modèle — deux modèles de la même clé
// ont chacun leur propre fenêtre.
const RPM_WINDOW_MS = 60_000;

// Marge de sécurité : on vise 80% du RPM officiel pour éviter
// les 429 liés au décalage d'horloge / burst.
const RPM_SAFETY_FACTOR = 0.8;

// Attente maximale quand tous les modèles sont en pause : au-delà on
// abandonne plutôt que de bloquer le tri pendant des heures (quotas
// journaliers, etc.).
const MAX_WAIT_MS = 90_000;

export interface CategorizeRequest {
  from: string;
  to: string;
  subject: string;
  body: string;
  categories: { id: string; name: string }[];
}

export interface BatchEmailItem {
  id: string;
  from: string;
  subject: string;
  snippet: string;
}

export interface BatchCategorizeResult {
  id: string;
  category_id: string;
  confidence: number;
  reason: string;
}

function buildSystemPrompt(categories: { id: string; name: string }[]): string {
  // Prompt compact : moins de tokens = plus rapide + moins de rate limit.
  const list = categories.map((c) => `${c.id}=${c.name}`).join(', ');
  return [
    'Classe l\'email dans une de ces catégories: ' + list + '.',
    'Réponds en JSON: {"category_id":"...","confidence":0.0-1.0,"reason":"justification courte en français"}.',
    'Si incertain, choisis "autre". Réponse JSON uniquement, pas d\'autre texte.',
  ].join(' ');
}

function buildUserPrompt(req: CategorizeRequest): string {
  // Corps tronqué à 1000 caractères (suffisant pour la classification,
  // réduit les tokens = moins de rate limit + plus rapide).
  const body = req.body.length > 1000 ? req.body.slice(0, 1000) : req.body;
  return `De: ${req.from}\nSujet: ${req.subject}\n${body}`;
}

export function extractJson(content: string): string {
  let trimmed = content.trim();
  // Retire les blocs markdown ```json ... ```.
  if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/,'');
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}

export function parseCategorization(content: string, categories: { id: string; name: string }[]): CategorizationOutput {
  const cleaned = extractJson(content);
  let v: any;
  try {
    v = JSON.parse(cleaned);
  } catch (e) {
    // Dernier recours : regex pour extraire category_id.
    const match = content.match(/"category_id"\s*:\s*"([^"]+)"/i);
    if (match) {
      const categoryId = match[1];
      if (categories.find((c) => c.id === categoryId || c.id.toLowerCase() === categoryId.toLowerCase())) {
        const confMatch = content.match(/"confidence"\s*:\s*([0-9.]+)/i);
        const reasonMatch = content.match(/"reason"\s*:\s*"([^"]+)"/i);
        return {
          category_id: categoryId,
          confidence: confMatch ? parseFloat(confMatch[1]) : 0.5,
          reason: reasonMatch ? reasonMatch[1] : 'Classification automatique',
        };
      }
    }
    throw new Error(`JSON invalide: ${(e as Error).message} — contenu: ${content.slice(0, 200)}`);
  }
  let categoryId = v.category_id;
  // Certains modèles utilisent "category" au lieu de "category_id".
  if (!categoryId && v.category) categoryId = v.category;
  if (typeof categoryId !== 'string') throw new Error('category_id absent ou non-string');

  if (!categories.find((c) => c.id === categoryId)) {
    const ci = categories.find((c) => c.id.toLowerCase() === categoryId.toLowerCase());
    if (ci) categoryId = ci.id;
    else throw new Error(`category_id "${categoryId}" inconnu parmi ${categories.map((c) => c.id).join(', ')}`);
  }
  // Confidence : accepte 0-1 ou 0-100.
  let confidence = typeof v.confidence === 'number' ? v.confidence : 0.5;
  if (confidence > 1) confidence = confidence / 100;
  confidence = Math.max(0, Math.min(1, confidence));
  const reason = typeof v.reason === 'string' ? v.reason : 'Classification automatique';
  return { category_id: categoryId, confidence, reason };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Batch categorization (8 mails par requête IA) ─────────────────────

function buildBatchSystemPrompt(categories: { id: string; name: string }[]): string {
  const list = categories.map((c) => `${c.id}=${c.name}`).join(', ');
  return [
    `Tu classifies {N} emails dans une de ces catégories: ${list}.`,
    'Réponds en JSON strict avec un objet contenant un tableau "results".',
    'Chaque élément doit avoir: id (l\'identifiant entre crochets), category_id, confidence (0.0-1.0), reason (court).',
    'Exemple: {"results":[{"id":"abc123","category_id":"travail","confidence":0.9,"reason":"email professionnel"}]}',
    'Si incertain, choisis "autre". JSON uniquement, pas d\'autre texte.',
  ].join(' ');
}

function buildBatchUserPrompt(emails: BatchEmailItem[]): string {
  return emails.map((e) => {
    const snippet = e.snippet.length > 280 ? e.snippet.slice(0, 280) : e.snippet;
    return `[${e.id}]\nDe: ${e.from}\nSujet: ${e.subject}\n${snippet}`;
  }).join('\n---\n');
}

export function parseBatchCategorization(content: string, categories: { id: string; name: string }[], emailIds: string[]): BatchCategorizeResult[] {
  const cleaned = extractJson(content);
  let v: any;
  try {
    v = JSON.parse(cleaned);
  } catch {
    // Essaie d'extraire le tableau directement.
    const arrMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try { v = { results: JSON.parse(arrMatch[0]) }; } catch { /* ignore */ }
    }
    // Dernier recours : extrait chaque objet JSON individuellement.
    if (!v) {
      const objMatches = cleaned.match(/\{[^{}]*"category_id"[^{}]*\}/gi);
      if (objMatches && objMatches.length > 0) {
        const items: any[] = [];
        for (const m of objMatches) {
          try { items.push(JSON.parse(m)); } catch { /* ignore */ }
        }
        if (items.length > 0) v = { results: items };
      }
    }
    if (!v) throw new Error(`Batch JSON invalide: ${content.slice(0, 200)}`);
  }

  const items = Array.isArray(v) ? v : (v.results ?? v.emails ?? []);
  if (!Array.isArray(items)) throw new Error('Réponse batch: pas un tableau');

  const validIds = new Set(emailIds);
  const catIds = new Set(categories.map((c) => c.id));
  const catIdsLower = new Set(categories.map((c) => c.id.toLowerCase()));

  const results: BatchCategorizeResult[] = [];
  for (const item of items) {
    const id = item.id ?? item.email_id ?? '';
    let categoryId = item.category_id ?? item.category ?? '';
    if (!id || !validIds.has(id)) continue;
    if (!catIds.has(categoryId)) {
      const lower = categoryId.toLowerCase();
      if (catIdsLower.has(lower)) {
        const found = categories.find((c) => c.id.toLowerCase() === lower);
        if (found) categoryId = found.id;
        else continue;
      } else continue;
    }
    let confidence = typeof item.confidence === 'number' ? item.confidence : 0.5;
    if (confidence > 1) confidence /= 100;
    confidence = Math.max(0, Math.min(1, confidence));
    const reason = typeof item.reason === 'string' ? item.reason : 'Classification automatique';
    results.push({ id, category_id: categoryId, confidence, reason });
  }
  return results;
}

// ─── Taxonomie des erreurs ─────────────────────────────────────────────
// Chaque type d'erreur déclenche une stratégie différente :
//   RateLimitError   → cooldown court du MODÈLE (RPM fenêtre glissante)
//   QuotaError       → cooldown long du MODÈLE (quota journalier/crédits)
//                      → rotation immédiate vers le modèle suivant
//   ModelDeadError   → modèle retiré définitivement de la file (session)
//   KeyDeadError     → clé invalide → provider entier retiré (session)
//   TimeoutError     → cooldown court du modèle
//   erreur générique → cooldown très court du modèle

export class RateLimitError extends Error {
  /** Cooldown en ms recommandé par le serveur (Retry-After), ou 0 si absent. */
  readonly retryAfterMs: number;
  constructor(msg: string, retryAfterMs = 0) {
    super(msg);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class QuotaError extends RateLimitError {
  constructor(msg: string, retryAfterMs = 0) {
    super(msg, retryAfterMs);
    this.name = 'QuotaError';
  }
}

export class ModelDeadError extends Error {
  constructor(msg: string) { super(msg); this.name = 'ModelDeadError'; }
}

export class KeyDeadError extends Error {
  constructor(msg: string) { super(msg); this.name = 'KeyDeadError'; }
}

export class TimeoutError extends Error {
  constructor(msg: string) { super(msg); this.name = 'TimeoutError'; }
}

export class CancelledError extends Error {
  constructor() { super('Tri annulé par l\'utilisateur'); this.name = 'CancelledError'; }
}

// ─── Annulation ─────────────────────────────────────────────────────────
// Prédicat posé par ipc.ts (lit `sortCancelled` en direct). Vérifié à
// chaque boucle de failover et chaque attente → l'annulation agit aussi
// PENDANT les cooldowns/sleeps, pas seulement entre les lots.
let cancelCheck: (() => boolean) | null = null;

export function onSortCancelCheck(cb: (() => boolean) | null): void {
  cancelCheck = cb;
}

function throwIfCancelled(): void {
  if (cancelCheck?.()) throw new CancelledError();
}

/**
 * Signaux de « quota épuisé » dans le corps d'erreur (≠ simple rate limit
 * RPM). Détecté sur le texte brut des réponses des différents providers :
 *  - Gemini  : "Resource has been exhausted", "quota exceeded",
 *              "generate_requests_per_model_per_day"
 *  - Groq    : "requests per day", "Rate limit reached ... on ... per day"
 *  - OpenRouter : 402 (crédits), "insufficient_quota"
 *  - autres  : "daily limit", "billing", "credits"
 */
const QUOTA_TEXT_RE =
  /quota|insufficient|resource has been exhausted|per.?day|daily|rpd|billing|credits?|free.?tier.*(limit|exceed)|requests?.*(per day|journalier)/i;

export function isQuotaText(text: string): boolean {
  return QUOTA_TEXT_RE.test(text);
}

/** Modèle introuvable/invalide dans le corps d'erreur (400 ambigu). */
const MODEL_NOT_FOUND_RE = /model.*(not.?found|does.?not.?exist|inval|decommission|deprecat|unsupported)|not.?found.*model|unknown.?model/i;

/** Clé invalide signalée dans un 400 (Gemini renvoie 400, pas 401, pour ça). */
const KEY_INVALID_RE =
  /api.?key.*(invalid|not.?valid|incorrect|missing|expired)|invalid.*api.?key|please pass a valid|bad.?credentials?|unauthorized|unregistered/i;

/**
 * Classe une erreur HTTP en stratégie de failover.
 * - 429 + texte quota          → QuotaError (modèle en pause longue, rotation)
 * - 429 simple                 → RateLimitError (cooldown court, Retry-After honoré)
 * - 429 + texte quota          → QuotaError (modèle en pause longue, rotation)
 * - 429 simple                 → RateLimitError (cooldown court, Retry-After honoré)
 * - 402                        → ModelDeadError (« crédits épuisés /
 *   PAYMENT_METHOD_REQUIRED » = le modèle ne marchera plus sur ce compte —
 *   inutile de re-tester : retiré de la file, rotation)
 * - 410                        → ModelDeadError (« Gone » = modèle EOL, NVIDIA)
 * - 401/403, ou 400 « key invalid » → KeyDeadError (provider entier mort)
 * - 404, ou 400 « model not found » → ModelDeadError (modèle retiré)
 * - 5xx                        → RateLimitError (transitoire, cooldown court)
 */
export function classifyHttpError(
  provider: AiProvider,
  status: number,
  text: string,
  retryAfterMs = 0,
): Error {
  const tag = `IA ${provider} ${status}`;
  const snippet = text.slice(0, 200);
  if (status === 429) {
    return isQuotaText(text)
      ? new QuotaError(`${tag} quota: ${snippet}`, retryAfterMs)
      : new RateLimitError(`${tag}: ${snippet}`, retryAfterMs);
  }
  if (status === 401 || status === 403 || (status === 400 && KEY_INVALID_RE.test(text))) {
    return new KeyDeadError(`${tag} clé invalide: ${snippet}`);
  }
  if (status === 402 || status === 404 || status === 410 || (status === 400 && MODEL_NOT_FOUND_RE.test(text))) {
    return new ModelDeadError(`${tag} modèle introuvable/retiré/indisponible: ${snippet}`);
  }
  if (status >= 500) {
    return new RateLimitError(`${tag} serveur: ${snippet}`, retryAfterMs);
  }
  return new Error(`${tag}: ${snippet}`);
}

/**
 * Cooldown conseillé pour un quota journalier épuisé :
 * - « retry in Ns » / "retryDelay": "Ns" dans le corps → respecté (≤24h)
 * - sinon → prochain reset estimé : minuit heure du Pacifique (reset
 *   des quotas journaliers Google/Groq), borné [1h, 24h].
 */
export function quotaCooldownMs(text: string): number {
  const m =
    text.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)\s*s"/i) ??
    text.match(/retry.{0,25}?(\d+(?:\.\d+)?)\s*s\b/i);
  if (m) return Math.min(parseFloat(m[1]) * 1000, 24 * 3600_000);
  return quotaResetMs();
}

/**
 * Millisecondes jusqu'à minuit heure du Pacifique (borné [1h, 24h]).
 * Calcule l'heure PT via Intl.DateTimeFormat.formatToParts — pas de
 * parsing de chaîne localisée (U+202F casse Date.parse).
 */
export function quotaResetMs(): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(Date.now());
  const v: Record<string, number> = {};
  for (const p of parts) if (p.type !== 'literal') v[p.type] = Number(p.value);
  // Heure murale PT interprétée comme UTC → la différence jusqu'à la
  // prochaine frontière de jour UTC = le temps avant minuit PT.
  const ptAsUtc = Date.UTC(v.year, v.month - 1, v.day, v.hour % 24, v.minute, v.second);
  const ms = (Math.floor(ptAsUtc / 86_400_000) + 1) * 86_400_000 - ptAsUtc;
  return Math.min(Math.max(ms, 3_600_000), 24 * 3_600_000);
}

// ─── État des providers (avec rotation de modèles) ─────────────────────

/** Configuration immuable d'un provider. */
export interface ProviderConfig {
  provider: AiProvider;
  apiKey: string;
  rpm: number;
}

/** État complet d'un provider : file de modèles, cooldowns, stats. */
export interface ProviderState {
  config: ProviderConfig;
  /** Modèles candidats ordonnés (meilleur d'abord). */
  models: string[];
  /** Modèles morts pour la session (404, dépréciés). */
  modelDead: Set<string>;
  /** Cooldown par modèle : timestamp de fin de pause. */
  modelCooldownUntil: Map<string, number>;
  /** Clé invalide → provider entier retiré pour la session. */
  keyDead: boolean;
  /** Dernier modèle utilisé (pour l'UI). */
  lastModelUsed: string | null;
  // Stats provider (niveau clé, tous modèles confondus).
  consecutiveFails: number;
  consecutiveRateLimits: number;
  totalRequests: number;
  totalSuccesses: number;
  totalRateLimits: number;
  totalErrors: number;
  totalTimeouts: number;
  /** Latence moyenne glissante (ms) — pour préférer les providers rapides. */
  avgLatencyMs: number;
  /** Timestamps récents PAR MODÈLE (fenêtre RPM propre à chaque modèle). */
  modelTimestamps: Map<string, number[]>;
}

/** Callback appelé après chaque tentative IA (succès ou échec). */
export type CategorizeCallback = (info: {
  provider: AiProvider;
  model: string;
  success: boolean;
  latencyMs: number;
  error?: string;
}) => void;

let categorizeCallback: CategorizeCallback | null = null;

/** Définit un callback appelé après chaque tentative de catégorisation. */
export function onCategorizeAttempt(cb: CategorizeCallback | null): void {
  categorizeCallback = cb;
}

let providerStates: ProviderState[] = [];

/**
 * Construit la file de modèles d'un provider :
 *   discovered primary → queue découverte → CURATED_MODELS (dédoublonnés).
 */
function buildModelQueue(settings: ProviderKeys, provider: AiProvider): string[] {
  const pm = settings.providerModels;
  const discovered = pm && provider in pm ? pm[provider] : undefined;
  const queue = settings.providerModelQueue?.[provider] ?? [];
  const list = [
    discovered ?? DEFAULT_MODELS[provider],
    ...queue,
    ...CURATED_MODELS[provider],
  ];
  return [...new Set(list.filter((m): m is string => !!m))];
}

/** Initialise les providers disponibles pour le failover + rotation. */
export function initProviders(settings: ProviderKeys): void {
  providerStates = [];

  for (const provider of AI_PROVIDERS) {
    const key = apiKeyFor(settings, provider);
    if (!key) continue;

    // Sémantique providerModels :
    //  - clé absente      → jamais testé → défaut + file curée.
    //  - valeur null      → discovery a tourné, rien de valide → skip.
    //  - valeur string    → modèle validé + queue + file curée.
    const pm = settings.providerModels;
    if (pm && provider in pm && !pm[provider]) continue;

    providerStates.push({
      config: { provider, apiKey: key, rpm: PROVIDER_RPM[provider] },
      models: buildModelQueue(settings, provider),
      modelDead: new Set(),
      modelCooldownUntil: new Map(),
      keyDead: false,
      lastModelUsed: null,
      consecutiveFails: 0,
      consecutiveRateLimits: 0,
      totalRequests: 0,
      totalSuccesses: 0,
      totalRateLimits: 0,
      totalErrors: 0,
      totalTimeouts: 0,
      avgLatencyMs: 0,
      modelTimestamps: new Map(),
    });
  }

  console.log('[IA] providers initialisés:', providerStates.map((p) =>
    `${p.config.provider}(${p.models.length} modèles, ${p.config.rpm} RPM/mod)`
  ).join(', '));
}

export function providerConfigsCount(): number {
  return providerStates.length;
}

/** Nombre total de modèles utilisables (toutes clés confondues). */
export function totalModelCount(): number {
  return providerStates.reduce((n, p) => n + p.models.length, 0);
}

/** Nom de modèle raccourci pour l'affichage (basename après « / »). */
export function shortModelName(id: string): string {
  const base = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  return base.replace(/:free$/, '');
}

/** Stats détaillées pour debug (1 ligne par provider, modèles inclus). */
export function getProviderStats(): string {
  if (providerStates.length === 0) return 'aucun provider configuré';
  const now = Date.now();
  return providerStates.map((p) => {
    const successRate = p.totalRequests > 0
      ? Math.round((p.totalSuccesses / p.totalRequests) * 100)
      : 100;
    const latency = p.avgLatencyMs > 0 ? `${Math.round(p.avgLatencyMs)}ms` : '-';
    const modelStr = p.models.map((m) => {
      if (p.modelDead.has(m)) return `${shortModelName(m)}:✗`;
      const cd = p.modelCooldownUntil.get(m) ?? 0;
      if (cd > now) return `${shortModelName(m)}:cd${Math.round((cd - now) / 1000)}s`;
      return `${shortModelName(m)}:✓`;
    }).join(' ');
    const key = p.keyDead ? ' [CLÉ MORTE]' : '';
    return `${p.config.provider}${key} [${modelStr}] ` +
      `${successRate}% ok (${p.totalSuccesses}/${p.totalRequests})` +
      `, ${p.totalRateLimits} RL, ${p.totalTimeouts} TO, ${p.totalErrors} err` +
      `, lat=${latency}`;
  }).join('\n');
}

/** Requêtes dans la fenêtre RPM pour UN modèle. */
function modelWindowCount(ps: ProviderState, model: string): number {
  const now = Date.now();
  const cutoff = now - RPM_WINDOW_MS;
  const ts = (ps.modelTimestamps.get(model) ?? []).filter((t) => t > cutoff);
  ps.modelTimestamps.set(model, ts);
  return ts.length;
}

/**
 * Choisit le modèle à utiliser pour ce provider :
 * le premier non-mort et hors cooldown — avec préférence pour celui
 * dont la fenêtre RPM est la moins chargée (les quotas gratuits sont
 * par modèle, donc répartir = plus de débit réel).
 */
export function pickModel(ps: ProviderState): string | null {
  const now = Date.now();
  let best: string | null = null;
  let bestLoad = Infinity;
  for (const m of ps.models) {
    if (ps.modelDead.has(m)) continue;
    if ((ps.modelCooldownUntil.get(m) ?? 0) > now) continue;
    const load = modelWindowCount(ps, m);
    if (load < bestLoad) {
      best = m;
      bestLoad = load;
    }
  }
  return best;
}

/** Timestamp du prochain modèle disponible (null si tous morts/clé morte). */
function earliestModelWake(ps: ProviderState): number | null {
  if (ps.keyDead) return null;
  let earliest = Infinity;
  for (const m of ps.models) {
    if (ps.modelDead.has(m)) continue;
    earliest = Math.min(earliest, ps.modelCooldownUntil.get(m) ?? 0);
  }
  return earliest === Infinity ? null : earliest;
}

/**
 * Calcule un "health score" pour un provider. Plus = mieux.
 * Prend en compte : taux de succès, latence, charge RPM du modèle choisi.
 */
function healthScore(ps: ProviderState): number {
  if (ps.keyDead) return -Infinity;

  const successRate = ps.totalRequests > 0
    ? ps.totalSuccesses / ps.totalRequests
    : 1.0;

  const latencyScore = ps.avgLatencyMs > 0
    ? Math.max(0.1, 500 / Math.max(ps.avgLatencyMs, 500))
    : 0.5;

  // Charge RPM du modèle le moins chargé (pickModel).
  const model = pickModel(ps);
  const maxRpm = ps.config.rpm * RPM_SAFETY_FACTOR;
  const loadScore = model === null
    ? 0
    : Math.max(0, 1 - (modelWindowCount(ps, model) / maxRpm));

  const failPenalty = Math.min(ps.consecutiveFails * 0.15, 0.5);

  // Succès (40%) + latence (25%) + charge (25%) - échecs (10%).
  return (successRate * 0.40) + (latencyScore * 0.25) + (loadScore * 0.25) - failPenalty;
}

/**
 * Sélectionne le meilleur provider disponible (health score max).
 * Si tous les modèles sont en pause, attend le premier réveil —
 * sauf si l'attente dépasse MAX_WAIT_MS (abandon net).
 */
async function selectBestProvider(): Promise<ProviderState> {
  if (providerStates.length === 0) {
    throw new Error('Aucun provider IA configuré. Renseignez au moins une clé API.');
  }
  if (providerStates.every((p) => p.keyDead)) {
    throw new KeyDeadError('Toutes les clés API sont invalides ou révoquées.');
  }

  while (true) {
    throwIfCancelled();
    const usable = providerStates.filter((p) => !p.keyDead && pickModel(p) !== null);
    if (usable.length > 0) {
      usable.sort((a, b) => healthScore(b) - healthScore(a));
      return usable[0];
    }

    // Tous les modèles en pause : réveil le plus proche.
    const wakes = providerStates
      .map(earliestModelWake)
      .filter((t): t is number => t !== null);
    if (wakes.length === 0) {
      throw new Error('Tous les modèles de tous les providers sont indisponibles.');
    }
    const wait = Math.min(...wakes) - Date.now();
    if (wait > MAX_WAIT_MS) {
      throw new Error(
        `Tous les providers en pause longue (quota journalier probable — ` +
        `réveil dans ~${Math.round(wait / 60000)} min). Réessayez plus tard.`
      );
    }
    console.warn(`[IA] tous les modèles en cooldown — attente ${Math.max(1, Math.ceil(wait / 1000))}s…`);
    await sleep(Math.max(1_000, Math.min(wait, 60_000)));
    throwIfCancelled();
  }
}

/**
 * Vérifie le RPM du modèle choisi ; si la fenêtre est pleine, attend
 * que la requête la plus ancienne en sorte.
 */
async function respectRpm(ps: ProviderState, model: string): Promise<void> {
  const maxRpm = Math.floor(ps.config.rpm * RPM_SAFETY_FACTOR);
  const recent = modelWindowCount(ps, model);
  if (recent >= maxRpm) {
    const ts = ps.modelTimestamps.get(model) ?? [];
    const oldest = ts[0] ?? Date.now();
    const waitMs = (oldest + RPM_WINDOW_MS) - Date.now() + 100;
    if (waitMs > 0) {
      console.log(`[IA] ${ps.config.provider}/${shortModelName(model)} : ${recent}/${maxRpm} RPM atteint, attente ${Math.round(waitMs / 1000)}s…`);
      await sleep(waitMs);
      throwIfCancelled();
    }
  }
}

/** Fetch avec timeout explicite. */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new TimeoutError(`Timeout après ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Extrait le Retry-After d'une réponse (header s ou HTTP-date). */
function parseRetryAfter(resp: Response): number {
  const raw = resp.headers.get('Retry-After');
  if (!raw) return 0;
  const asNum = Number(raw);
  if (!isNaN(asNum) && asNum > 0) return asNum * 1000;
  const asDate = Date.parse(raw);
  if (!isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return 0;
}

/** Envoie une requête chat/completions et classe les erreurs HTTP. */
async function chatRequest(
  cfg: ProviderConfig & { model: string },
  messages: { role: string; content: string }[],
  maxTokens: number,
): Promise<string> {
  const url = PROVIDER_URLS[cfg.provider];
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
  };
  if (cfg.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/ATSDopi/ATS-Mail-Sorter';
    headers['X-Title'] = 'Mail Sorter AI';
  }

  // response_format json_object : seuls OpenRouter/Groq/Gemini l'acceptent
  // proprement. Cerebras/NVIDIA/SambaNova peuvent 400 dessus — le prompt
  // demande déjà du JSON et extractJson gère le texte enveloppé.
  const JSON_MODE: Record<AiProvider, boolean> = {
    openrouter: true, groq: true, gemini: true,
    nvidia: false, sambanova: false, cerebras: false,
  };
  const body = JSON.stringify({
    model: cfg.model,
    temperature: 0,
    max_tokens: maxTokens,
    ...(JSON_MODE[cfg.provider] ? { response_format: { type: 'json_object' } } : {}),
    messages,
  });

  const resp = await fetchWithTimeout(url, { method: 'POST', headers, body }, REQUEST_TIMEOUT_MS);
  const text = await resp.text();

  if (!resp.ok) {
    throw classifyHttpError(cfg.provider, resp.status, text, parseRetryAfter(resp));
  }

  const v = JSON.parse(text);
  const content = v?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('content absent dans la réponse IA');
  return content;
}

/** Met à jour la latence moyenne glissante d'un provider. */
function updateLatency(ps: ProviderState, latencyMs: number): void {
  ps.avgLatencyMs = ps.avgLatencyMs === 0
    ? latencyMs
    : ps.avgLatencyMs * 0.8 + latencyMs * 0.2;
}

/**
 * Stratégie d'erreur appliquée à un (provider, modèle) après un échec.
 * Retourne true si l'échec doit arrêter le tri (clé morte partout).
 */
function applyErrorStrategy(
  ps: ProviderState,
  model: string,
  e: unknown,
  tag: string,
): void {
  const now = Date.now();
  const p = ps.config.provider;
  const mName = shortModelName(model);

  if (e instanceof KeyDeadError) {
    ps.keyDead = true;
    ps.totalErrors++;
    ps.consecutiveFails++;
    console.error(`[${tag}] ${p} clé invalide — provider retiré de la session`);
    return;
  }
  if (e instanceof ModelDeadError) {
    ps.modelDead.add(model);
    ps.totalErrors++;
    ps.consecutiveFails++;
    console.warn(`[${tag}] ${p}/${mName} modèle mort — retiré de la file (${ps.models.length - ps.modelDead.size} restants)`);
    return;
  }
  if (e instanceof QuotaError) {
    ps.totalRateLimits++;
    ps.consecutiveRateLimits++;
    ps.consecutiveFails++;
    // Quota journalier : pause longue, jusqu'au reset estimé.
    const cd = e.retryAfterMs > 0
      ? Math.min(e.retryAfterMs, 24 * 3600_000)
      : quotaCooldownMs(e.message);
    ps.modelCooldownUntil.set(model, now + cd);
    console.warn(
      `[${tag}] ${p}/${mName} quota épuisé — modèle en pause ` +
      `${Math.round(cd / 60000)}min — rotation (${ps.models.length - ps.modelDead.size - [...ps.modelCooldownUntil.values()].filter(t => t > now).length} dispo)`
    );
    return;
  }
  if (e instanceof RateLimitError) {
    ps.totalRateLimits++;
    ps.consecutiveRateLimits++;
    ps.consecutiveFails++;
    const cd = e.retryAfterMs > 0
      ? Math.min(e.retryAfterMs, MAX_COOLDOWN_MS)
      : Math.min(BASE_COOLDOWN_MS * Math.pow(2, ps.consecutiveRateLimits - 1), MAX_COOLDOWN_MS);
    ps.modelCooldownUntil.set(model, now + cd);
    console.warn(`[${tag}] ${p}/${mName} 429 — modèle en pause ${Math.round(cd / 1000)}s — rotation`);
    return;
  }
  if (e instanceof TimeoutError) {
    ps.totalTimeouts++;
    ps.consecutiveFails++;
    ps.modelCooldownUntil.set(model, now + 10_000);
    console.warn(`[${tag}] ${p}/${mName} timeout — modèle en pause 10s`);
    return;
  }
  ps.totalErrors++;
  ps.consecutiveFails++;
  ps.modelCooldownUntil.set(model, now + 5_000);
  console.warn(`[${tag}] ${p}/${mName} erreur: ${e instanceof Error ? e.message.slice(0, 120) : e} — pause 5s`);
}

/**
 * Moteur de failover commun : sélectionne provider+modèle, exécute
 * l'appel, applique la stratégie d'erreur, recommence.
 *
 * 1. Health score par provider (succès + latence + charge RPM du modèle).
 * 2. Rotation de modèles : quotas par modèle → modèle suivant sur la
 *    même clé avant de changer de provider.
 * 3. Retry-After honoré ; cooldowns exponentiels pour les 429.
 * 4. Quota journalier → pause longue du modèle, rotation immédiate.
 * 5. Clé morte → provider retiré ; modèle mort → retiré de la file.
 */
async function runWithFailover<T>(
  tag: string,
  call: (cfg: ProviderConfig & { model: string }) => Promise<T>,
): Promise<T> {
  let lastError: Error | null = null;
  let totalAttempts = 0;
  const maxTotalAttempts = Math.max(4, totalModelCount() * 2);
  const triedPairs = new Set<string>();

  while (totalAttempts < maxTotalAttempts) {
    throwIfCancelled();
    let ps: ProviderState;
    try {
      ps = await selectBestProvider();
    } catch (e) {
      // Plus rien de disponible : propage la vraie cause si on l'a.
      throw lastError ?? e;
    }

    const model = pickModel(ps)!; // selectBestProvider garantit non-null
    const pairKey = `${ps.config.provider}|${model}`;
    if (triedPairs.has(pairKey) && triedPairs.size >= totalModelCount()) {
      // Tous les couples (provider, modèle) ont été essayés : pause globale.
      if (lastError instanceof KeyDeadError) break;
      console.warn(`[${tag}] tous les modèles essayés — attente 5s avant retry…`);
      await sleep(5_000);
      throwIfCancelled();
      triedPairs.clear();
      continue;
    }
    triedPairs.add(pairKey);
    totalAttempts++;

    await respectRpm(ps, model);
    ps.totalRequests++;
    const ts = ps.modelTimestamps.get(model) ?? [];
    ts.push(Date.now());
    ps.modelTimestamps.set(model, ts);

    const startTime = Date.now();
    try {
      const result = await call({ ...ps.config, model });
      const latency = Date.now() - startTime;

      ps.consecutiveFails = 0;
      ps.consecutiveRateLimits = 0;
      ps.totalSuccesses++;
      ps.lastModelUsed = model;
      updateLatency(ps, latency);

      if (totalAttempts > 1) {
        console.log(`[${tag}] ${ps.config.provider}/${shortModelName(model)} OK en ${latency}ms (tentative ${totalAttempts})`);
      }
      categorizeCallback?.({ provider: ps.config.provider, model, success: true, latencyMs: latency });
      return result;

    } catch (e) {
      const latency = Date.now() - startTime;
      if (latency > 0) updateLatency(ps, latency);
      categorizeCallback?.({
        provider: ps.config.provider, model, success: false, latencyMs: latency,
        error: String(e instanceof Error ? e.message : e),
      });
      applyErrorStrategy(ps, model, e, tag);
      lastError = e instanceof Error ? e : new Error(String(e));
      continue;
    }
  }

  console.error(`[${tag}] échec après ${totalAttempts} tentatives. Dernière erreur: ${lastError?.message}`);
  throw lastError ?? new Error(`Échec ${tag} après tous les providers/modèles`);
}

/**
 * Catégorise un mail avec failover automatique + rotation de modèles.
 */
export async function categorize(
  req: CategorizeRequest
): Promise<CategorizationOutput> {
  return runWithFailover('IA', async (cfg) => {
    const content = await chatRequest(cfg, [
      { role: 'system', content: buildSystemPrompt(req.categories) },
      { role: 'user', content: buildUserPrompt(req) },
    ], 512);
    return parseCategorization(content, req.categories);
  });
}

/**
 * Catégorise un lot d'emails (jusqu'à 8) en une seule requête IA.
 * Retourne les résultats pour les emails réussis (les échecs sont omis).
 */
export async function categorizeBatch(
  emails: BatchEmailItem[],
  categories: { id: string; name: string }[]
): Promise<BatchCategorizeResult[]> {
  if (emails.length === 0) return [];
  return runWithFailover('IA batch', async (cfg) => {
    const system = buildBatchSystemPrompt(categories).replace('{N}', String(emails.length));
    const content = await chatRequest(cfg, [
      { role: 'system', content: system },
      { role: 'user', content: buildBatchUserPrompt(emails) },
    ], 2048);
    return parseBatchCategorization(content, categories, emails.map((e) => e.id));
  });
}
