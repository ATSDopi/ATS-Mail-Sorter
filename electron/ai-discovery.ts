import type { AiProvider } from './types';
import { DEFAULT_MODELS } from './ai';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const NVIDIA_MODELS_URL = 'https://integrate.api.nvidia.com/v1/models';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';
const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const SAMBANOVA_MODELS_URL = 'https://api.sambanova.ai/v1/models';
const CEREBRAS_MODELS_URL = 'https://api.cerebras.ai/v1/models';

const PROVIDER_CHAT_URLS: Record<AiProvider, string> = {
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  nvidia: 'https://integrate.api.nvidia.com/v1/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  sambanova: 'https://api.sambanova.ai/v1/chat/completions',
  cerebras: 'https://api.cerebras.ai/v1/chat/completions',
};

export interface ModelInfo {
  id: string;
  provider: AiProvider;
  contextLength: number | null;
  isFree: boolean;
  /** Score de qualité estimé (plus = mieux). */
  qualityScore: number;
  /** Disponibilité testée (null = non testé, true = OK, false = KO). */
  available: boolean | null;
}

interface OpenRouterModel {
  id: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { modality?: string };
}
interface OpenRouterResponse { data: OpenRouterModel[]; }
interface NvidiaModel { id: string; }
interface NvidiaResponse { data: NvidiaModel[]; }

/** Mots-clés pour exclure les modèles non-chat (embed, vision-only, code-only, safety, translate...). */
const EXCLUDE_KEYWORDS = [
  'embed', 'codegemma', 'starcoder', 'deplot', 'vlm', 'vision',
  'safety', 'guard', 'translate', 'riva', 'retriever', 'nvclip',
  'neva', 'vila', 'cosmos', 'parse', 'calibration', 'synthetic',
  'diffusion', 'muse', 'recurrent', 'fuyu', 'kosmos', 'arctic',
  'palmyra-med', 'palmyra-fin', 'palmyra-creative',
];

/** Préfixes de familles de modèles de chat de qualité (ordre = priorité du match). */
const QUALITY_FAMILIES: { match: RegExp; score: number }[] = [
  // Très haut de gamme
  { match: /deepseek.*v4.*pro/i, score: 100 },
  { match: /nemotron.*4.*340/i, score: 95 },
  { match: /nemotron.*ultra.*253/i, score: 92 },
  { match: /gpt-oss.*120/i, score: 90 },
  { match: /kimi.*k3/i, score: 88 },
  { match: /nemotron.*super.*120/i, score: 85 },
  { match: /minimax.*m3/i, score: 82 },
  // Gemini : pro > flash > flash-lite (les alias "-latest" matchent aussi)
  { match: /gemini.*pro/i, score: 81 },
  { match: /mistral.*large/i, score: 80 },
  { match: /mixtral.*8x22/i, score: 78 },
  { match: /llama.*90b/i, score: 75 },
  { match: /qwen.*235/i, score: 74 },
  { match: /gemini.*flash(?!.*lite)/i, score: 73 },
  { match: /nemotron.*70/i, score: 72 },
  { match: /glm.*5/i, score: 70 },
  { match: /llama.*3\.3.*70b/i, score: 69 },
  { match: /gemma.*4.*31/i, score: 68 },
  { match: /deepseek.*v4/i, score: 65 },
  { match: /qwen.*32b/i, score: 63 },
  { match: /gemini.*flash.*lite/i, score: 62 },
  { match: /mistral.*nemotron/i, score: 60 },
  { match: /yi.*large/i, score: 57 },
  { match: /phi.*3\.5.*moe/i, score: 55 },
  { match: /qwen.*3\.8/i, score: 53 },
  { match: /jamba/i, score: 50 },
  { match: /gemma.*4.*26/i, score: 50 },
  { match: /nemotron.*nano.*30/i, score: 45 },
  { match: /gpt-oss.*20/i, score: 42 },
  { match: /mistral.*7b/i, score: 40 },
  { match: /llama.*3\.1.*8b/i, score: 36 },
  { match: /llama.*3\.2.*11/i, score: 35 },
  { match: /allam/i, score: 32 },
  { match: /dbrx/i, score: 30 },
  { match: /gemma.*3.*12/i, score: 30 },
  { match: /gemma.*3.*4/i, score: 25 },
];

/** Bonus de score pour les modèles avec grand contexte. */
function contextBonus(ctx: number | null): number {
  if (!ctx) return 0;
  if (ctx >= 500000) return 10;
  if (ctx >= 200000) return 5;
  if (ctx >= 100000) return 3;
  return 0;
}

export function isChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  return !EXCLUDE_KEYWORDS.some((kw) => lower.includes(kw));
}

export function qualityScore(id: string, ctx: number | null): number {
  let score = 10; // score de base
  for (const fam of QUALITY_FAMILIES) {
    if (fam.match.test(id)) {
      score = Math.max(score, fam.score);
      break;
    }
  }
  score += contextBonus(ctx);
  return score;
}

/** Récupère tous les modèles disponibles chez OpenRouter. */
export async function fetchOpenRouterModels(apiKey: string): Promise<ModelInfo[]> {
  const resp = await fetch(OPENROUTER_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) throw new Error(`OpenRouter models ${resp.status}`);
  const data: OpenRouterResponse = await resp.json();
  return data.data
    .filter((m) => isChatModel(m.id))
    .map((m) => {
      const isFree = m.id.endsWith(':free') || (m.pricing?.prompt === '0' && m.pricing?.completion === '0');
      return {
        id: m.id,
        provider: 'openrouter' as AiProvider,
        contextLength: m.context_length ?? null,
        isFree,
        qualityScore: qualityScore(m.id, m.context_length ?? null),
        available: null,
      };
    });
}

/** Récupère tous les modèles disponibles chez NVIDIA NIM. */
export async function fetchNvidiaModels(apiKey: string): Promise<ModelInfo[]> {
  const resp = await fetch(NVIDIA_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) throw new Error(`NVIDIA models ${resp.status}`);
  const data: NvidiaResponse = await resp.json();
  return data.data
    .filter((m) => isChatModel(m.id))
    .map((m) => ({
      id: m.id,
      provider: 'nvidia' as AiProvider,
      contextLength: null,
      isFree: true, // NVIDIA NIM est gratuit pendant la période d'accès
      qualityScore: qualityScore(m.id, null),
      available: null,
    }));
}

/** Récupère tous les modèles disponibles chez Groq. */
export async function fetchGroqModels(apiKey: string): Promise<ModelInfo[]> {
  const resp = await fetch(GROQ_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) throw new Error(`Groq models ${resp.status}`);
  const data: NvidiaResponse = await resp.json(); // même format { data: [{id}] }
  return data.data
    .filter((m) => isChatModel(m.id))
    .map((m) => ({
      id: m.id,
      provider: 'groq' as AiProvider,
      contextLength: null,
      isFree: true, // Groq est gratuit
      qualityScore: qualityScore(m.id, null),
      available: null,
    }));
}

/** Récupère les modèles Gemini disponibles (Google AI). */
export async function fetchGeminiModels(apiKey: string): Promise<ModelInfo[]> {
  const resp = await fetch(`${GEMINI_MODELS_URL}?key=${apiKey}`);
  if (!resp.ok) throw new Error(`Gemini models ${resp.status}`);
  const data = await resp.json();
  const models: ModelInfo[] = [];
  for (const m of data.models ?? []) {
    const id = m.name?.replace('models/', '') ?? '';
    if (!id) continue;
    // Garde seulement les modèles qui supportent generateContent (chat).
    if (!m.supportedGenerationMethods?.includes('generateContent')) continue;
    models.push({
      id,
      provider: 'gemini' as AiProvider,
      contextLength: m.inputTokenLimit ?? null,
      isFree: true, // Gemini free tier
      qualityScore: qualityScore(id, m.inputTokenLimit ?? null),
      available: null,
    });
  }
  return models;
}

/** Récupère les modèles SambaNova. */
export async function fetchSambanovaModels(apiKey: string): Promise<ModelInfo[]> {
  const resp = await fetch(SAMBANOVA_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) throw new Error(`SambaNova models ${resp.status}`);
  const data: NvidiaResponse = await resp.json(); // même format { data: [{id}] }
  return data.data
    .filter((m) => isChatModel(m.id))
    .map((m) => ({
      id: m.id,
      provider: 'sambanova' as AiProvider,
      contextLength: null,
      isFree: true,
      qualityScore: qualityScore(m.id, null),
      available: null,
    }));
}

/** Récupère les modèles Cerebras. */
export async function fetchCerebrasModels(apiKey: string): Promise<ModelInfo[]> {
  const resp = await fetch(CEREBRAS_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) throw new Error(`Cerebras models ${resp.status}`);
  const data: NvidiaResponse = await resp.json();
  return data.data
    .filter((m) => isChatModel(m.id))
    .map((m) => ({
      id: m.id,
      provider: 'cerebras' as AiProvider,
      contextLength: null,
      isFree: true,
      qualityScore: qualityScore(m.id, null),
      available: null,
    }));
}

/** Récupère les modèles d'un provider (une fonction par provider). */
export const MODEL_FETCHERS: Record<AiProvider, (apiKey: string) => Promise<ModelInfo[]>> = {
  openrouter: fetchOpenRouterModels,
  nvidia: fetchNvidiaModels,
  groq: fetchGroqModels,
  gemini: fetchGeminiModels,
  sambanova: fetchSambanovaModels,
  cerebras: fetchCerebrasModels,
};

export type ModelTestStatus = 'ok' | 'ratelimit' | 'fail';

export interface ModelTestResult {
  status: ModelTestStatus;
  /** Code HTTP ou détail d'erreur pour le diagnostic. */
  detail?: string;
}

/**
 * Teste si un modèle répond réellement à une requête chat.
 * 'ratelimit' (429) ≠ 'fail' : le modèle est probablement valide mais
 * occupé — la discovery ne doit pas graver « aucun modèle » pour ça.
 */
export async function testModelDetailed(
  provider: AiProvider,
  apiKey: string,
  modelId: string,
  timeoutMs = 20000
): Promise<ModelTestResult> {
  const url = PROVIDER_CHAT_URLS[provider];
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/ATSDopi/ATS-Mail-Sorter';
    headers['X-Title'] = 'Mail Sorter AI';
  }
  const body = JSON.stringify({
    model: modelId,
    messages: [{ role: 'user', content: 'Reply with just: OK' }],
    // 32 tokens : les modèles à raisonnement (gpt-oss, nemotron…)
    // dépensent les premiers tokens à penser — avec 5 ils répondent vide.
    max_tokens: 32,
    temperature: 0,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (resp.status === 429) return { status: 'ratelimit', detail: 'HTTP 429' };
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      return { status: 'fail', detail: `HTTP ${resp.status} ${t.slice(0, 120)}` };
    }
    const v = await resp.json();
    const choice = v?.choices?.[0];
    const msg = choice?.message;
    // OK si du contenu OU du raisonnement non vide, ou si le modèle a
    // consommé tout le budget en réfléchissant (finish_reason=length).
    const alive = !!msg?.content || !!msg?.reasoning || choice?.finish_reason === 'length';
    return { status: alive ? 'ok' : 'fail', detail: alive ? undefined : 'réponse vide' };
  } catch (e) {
    clearTimeout(timer);
    return { status: 'fail', detail: String(e).slice(0, 120) };
  }
}

/** Version booléenne de testModel pour les appels simples. */
export async function testModel(
  provider: AiProvider,
  apiKey: string,
  modelId: string,
  timeoutMs = 20000
): Promise<ModelTestStatus> {
  return (await testModelDetailed(provider, apiKey, modelId, timeoutMs)).status;
}

export interface DiscoveryResult {
  /**
   * Meilleur modèle validé :
   * - string → modèle validé.
   * - null → testé, rien ne fonctionne (provider ignoré au tri).
   * - undefined → NON CONCLUANT (rate-limits en série) → ne rien graver,
   *   le runtime utilisera défaut + file curée.
   */
  primary: string | null | undefined;
  /** Modèles de secours validés, ordonnés par qualité (rotation runtime). */
  queue: string[];
}

/**
 * Découvre les meilleurs modèles valides pour UN provider :
 * 1. Teste le modèle par défaut (rapide, 1 requête).
 * 2. Liste les modèles, trie par score de qualité, teste les candidats
 *    jusqu'à `limit` modèles valides (le déjà-testé compte).
 * Retourne primary + queue (file de rotation pour le failover quota).
 */
export async function discoverModels(
  provider: AiProvider,
  apiKey: string,
  limit = 4,
): Promise<DiscoveryResult> {
  const found: string[] = [];
  let ratelimited = false;
  let lastDetail = '';

  const tryModel = async (id: string, tag: string): Promise<boolean> => {
    try {
      // Jusqu'à 2 essais : un 429 transitoire ne doit pas disqualifier.
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await testModelDetailed(provider, apiKey, id);
        lastDetail = r.detail ?? r.status;
        if (r.status === 'ok') {
          console.log(`[IA] discovery ${provider} → ${id} ${tag} ✓`);
          found.push(id);
          return true;
        }
        if (r.status === 'ratelimit') {
          ratelimited = true;
          if (attempt === 0) {
            await new Promise((res) => setTimeout(res, 3_000));
            continue;
          }
        }
        console.warn(`[IA] discovery ${provider} ${id} ${tag} → ${r.status}${r.detail ? ` (${r.detail})` : ''}`);
        break;
      }
    } catch (e) {
      console.warn(`[IA] discovery ${provider} ${tag} erreur:`, e);
    }
    return false;
  };

  // 1. Modèle par défaut d'abord — le cas le plus courant.
  await tryModel(DEFAULT_MODELS[provider], '(défaut)');

  // 2. Liste des modèles, triés par qualité — complète la file de rotation.
  try {
    const models = await MODEL_FETCHERS[provider](apiKey);
    // Gratuits d'abord, puis score de qualité décroissant.
    models.sort((a, b) => {
      if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
      return b.qualityScore - a.qualityScore;
    });
    let tested = 0;
    for (const candidate of models) {
      if (found.length >= limit || tested >= 8) break;
      if (found.includes(candidate.id)) continue;
      tested++;
      await tryModel(candidate.id, '(liste)');
      await new Promise((r) => setTimeout(r, 700));
    }
  } catch (e) {
    console.warn(`[IA] discovery ${provider} : liste des modèles inaccessible:`, e);
  }

  if (found.length === 0) {
    if (ratelimited) {
      // Rate-limits en série : test non concluant → ne pas graver « mort ».
      console.warn(`[IA] discovery ${provider} : non concluant (rate-limit)`);
      return { primary: undefined, queue: [] };
    }
    console.warn(`[IA] discovery ${provider} : aucun modèle valide trouvé (dernier: ${lastDetail})`);
    return { primary: null, queue: [] };
  }
  return { primary: found[0], queue: found.slice(1) };
}
