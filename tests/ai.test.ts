import { describe, it, expect } from 'vitest';
import {
  extractJson,
  parseCategorization,
  parseBatchCategorization,
  AI_PROVIDERS,
  API_KEY_FIELD,
  apiKeyFor,
  DEFAULT_MODELS,
  CURATED_MODELS,
  classifyHttpError,
  isQuotaText,
  quotaResetMs,
  quotaCooldownMs,
  pickModel,
  initProviders,
  totalModelCount,
  RateLimitError,
  QuotaError,
  ModelDeadError,
  KeyDeadError,
  type ProviderState,
} from '../electron/ai';

const CATS = [
  { id: 'travail', name: 'Travail' },
  { id: 'personnel', name: 'Personnel' },
  { id: 'autre', name: 'Autre' },
];

describe('extractJson', () => {
  it('retourne le JSON tel quel', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it('retire les fences markdown', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('extrait le premier objet dans du texte parasite', () => {
    expect(extractJson('Voici la réponse: {"a":1} fin.')).toBe('{"a":1}');
  });

  it('gère le texte sans JSON', () => {
    expect(extractJson('rien du tout')).toBe('rien du tout');
  });
});

describe('parseCategorization', () => {
  it('parse une réponse nominale', () => {
    const out = parseCategorization(
      '{"category_id":"travail","confidence":0.9,"reason":"réunion"}', CATS);
    expect(out).toEqual({ category_id: 'travail', confidence: 0.9, reason: 'réunion' });
  });

  it('accepte "category" comme alias de category_id', () => {
    const out = parseCategorization('{"category":"personnel","confidence":0.5}', CATS);
    expect(out.category_id).toBe('personnel');
  });

  it('normalise une confidence 0-100 en 0-1', () => {
    const out = parseCategorization('{"category_id":"travail","confidence":85}', CATS);
    expect(out.confidence).toBe(0.85);
  });

  it('match la catégorie sans tenir compte de la casse', () => {
    const out = parseCategorization('{"category_id":"TRAVAIL","confidence":0.9}', CATS);
    expect(out.category_id).toBe('travail');
  });

  it('rejette une catégorie inconnue', () => {
    expect(() => parseCategorization('{"category_id":"inconnu","confidence":0.9}', CATS))
      .toThrow(/category_id "inconnu" inconnu/);
  });

  it('fallback regex sur JSON cassé', () => {
    const out = parseCategorization(
      'réponse bizarre: "category_id": "travail", "confidence": 0.7, "reason": "ok"', CATS);
    expect(out.category_id).toBe('travail');
    expect(out.confidence).toBe(0.7);
  });

  it('rejette un contenu sans aucune catégorie valide', () => {
    expect(() => parseCategorization('{"foo":1}', CATS)).toThrow();
  });
});

describe('parseBatchCategorization', () => {
  const IDS = ['m1', 'm2', 'm3'];

  it('parse le format nominal {results:[…]}', () => {
    const out = parseBatchCategorization(
      '{"results":[{"id":"m1","category_id":"travail","confidence":0.9,"reason":"r"},' +
      '{"id":"m2","category_id":"personnel","confidence":0.4,"reason":"r2"}]}', CATS, IDS);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 'm1', category_id: 'travail' });
    expect(out[1]).toMatchObject({ id: 'm2', category_id: 'personnel' });
  });

  it('accepte un tableau JSON direct', () => {
    const out = parseBatchCategorization(
      '[{"id":"m1","category_id":"autre","confidence":0.5,"reason":"x"}]', CATS, IDS);
    expect(out).toHaveLength(1);
  });

  it('ignore les ids inconnus (hallucination du modèle)', () => {
    const out = parseBatchCategorization(
      '{"results":[{"id":"m1","category_id":"travail","confidence":0.9,"reason":"r"},' +
      '{"id":"hallucine","category_id":"travail","confidence":0.9,"reason":"r"}]}', CATS, IDS);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('m1');
  });

  it('ignore les catégories inconnues', () => {
    const out = parseBatchCategorization(
      '{"results":[{"id":"m1","category_id":"nope","confidence":0.9,"reason":"r"}]}', CATS, IDS);
    expect(out).toHaveLength(0);
  });

  it('récupère les objets individuels d\'un JSON partiellement cassé', () => {
    const out = parseBatchCategorization(
      'bla {"id":"m1","category_id":"travail","confidence":0.9,"reason":"r"} bla ' +
      '{"id":"m2","category_id":"autre","confidence":0.6,"reason":"r2"}', CATS, IDS);
    expect(out.map((r) => r.id).sort()).toEqual(['m1', 'm2']);
  });

  it('lève une erreur si rien n\'est exploitable', () => {
    expect(() => parseBatchCategorization('rien', CATS, IDS)).toThrow();
  });
});

describe('registre providers', () => {
  it('6 providers, un champ de clé chacun', () => {
    expect(AI_PROVIDERS).toHaveLength(6);
    for (const p of AI_PROVIDERS) {
      expect(API_KEY_FIELD[p]).toMatch(/ApiKey$/);
      expect(DEFAULT_MODELS[p]).toBeTruthy();
      expect(CURATED_MODELS[p].length).toBeGreaterThan(0);
    }
  });

  it('apiKeyFor lit le bon champ', () => {
    const s = {
      openrouterApiKey: 'a', nvidiaApiKey: null, groqApiKey: 'g',
      geminiApiKey: 'AIza', sambanovaApiKey: null, cerebrasApiKey: null,
      providerModels: {},
      providerModelQueue: {},
    };
    expect(apiKeyFor(s, 'gemini')).toBe('AIza');
    expect(apiKeyFor(s, 'nvidia')).toBeNull();
  });
});

// ─── Classification des erreurs ──────────────────────────────────────────

describe('isQuotaText', () => {
  it('détecte les signaux de quota journalier', () => {
    for (const t of [
      'Resource has been exhausted (e.g. check quota).',
      'Quota exceeded for metric: generate_requests_per_model_per_day',
      'Rate limit reached for model llama-3.3 on requests per day (RPD)',
      'insufficient_quota', 'daily limit exceeded', 'billing limit',
      'exceeded your current quota',
    ]) {
      expect(isQuotaText(t), t).toBe(true);
    }
  });

  it('ne confond pas un simple rate limit RPM', () => {
    expect(isQuotaText('Too many requests, retry later')).toBe(false);
    expect(isQuotaText('requests per minute exceeded')).toBe(false);
  });
});

describe('classifyHttpError', () => {
  it('402 → ModelDeadError (modèle payant sans crédit = jamais, ex. SambaNova)', () => {
    expect(classifyHttpError('sambanova', 402, 'PAYMENT_METHOD_REQUIRED balance_units:0')).toBeInstanceOf(ModelDeadError);
    expect(classifyHttpError('openrouter', 402, 'insufficient credits')).toBeInstanceOf(ModelDeadError);
  });

  it('410 → ModelDeadError (« Gone » = modèle EOL, ex. NVIDIA)', () => {
    expect(classifyHttpError('nvidia', 410, '{"title":"Gone"}')).toBeInstanceOf(ModelDeadError);
  });

  it('400 + clé invalide → KeyDeadError (cas Gemini)', () => {
    const e = classifyHttpError('gemini', 400, 'Please pass a valid API key');
    expect(e).toBeInstanceOf(KeyDeadError);
  });

  it('429 + texte quota → QuotaError', () => {
    const e = classifyHttpError('gemini', 429, 'Resource has been exhausted (check quota)');
    expect(e).toBeInstanceOf(QuotaError);
  });

  it('429 simple → RateLimitError (pas quota)', () => {
    const e = classifyHttpError('groq', 429, 'Too many requests per minute');
    expect(e).toBeInstanceOf(RateLimitError);
    expect(e).not.toBeInstanceOf(QuotaError);
  });

  it('401/403 → KeyDeadError (provider entier retiré)', () => {
    expect(classifyHttpError('groq', 401, 'invalid api key')).toBeInstanceOf(KeyDeadError);
    expect(classifyHttpError('nvidia', 403, 'forbidden')).toBeInstanceOf(KeyDeadError);
  });

  it('404 / 400 modèle introuvable → ModelDeadError', () => {
    expect(classifyHttpError('gemini', 404, 'model not found')).toBeInstanceOf(ModelDeadError);
    expect(classifyHttpError('cerebras', 400, 'model does not exist')).toBeInstanceOf(ModelDeadError);
  });

  it('400 sans mention de modèle → erreur générique', () => {
    const e = classifyHttpError('groq', 400, 'malformed request body');
    expect(e).not.toBeInstanceOf(ModelDeadError);
    expect(e).not.toBeInstanceOf(RateLimitError);
  });

  it('5xx → RateLimitError (transitoire)', () => {
    expect(classifyHttpError('nvidia', 503, 'upstream unavailable')).toBeInstanceOf(RateLimitError);
  });
});

describe('quotaCooldownMs / quotaResetMs', () => {
  it('parse un retryDelay explicite', () => {
    expect(quotaCooldownMs('{"retryDelay":"3600s"}')).toBe(3600_000);
    expect(quotaCooldownMs('Please retry in 120.5s')).toBe(120_500);
  });

  it('plafonne à 24h', () => {
    expect(quotaCooldownMs('{"retryDelay":"999999s"}')).toBe(24 * 3600_000);
  });

  it('sans indication → reset minuit Pacifique borné [1h, 24h]', () => {
    const ms = quotaResetMs();
    expect(ms).toBeGreaterThanOrEqual(3600_000);
    expect(ms).toBeLessThanOrEqual(24 * 3600_000);
  });
});

// ─── Rotation des modèles ────────────────────────────────────────────────

function fakeState(models: string[]): ProviderState {
  return {
    config: { provider: 'gemini', apiKey: 'k', rpm: 15 },
    models,
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
  };
}

describe('pickModel (rotation)', () => {
  it('prend le premier modèle disponible', () => {
    const ps = fakeState(['a', 'b', 'c']);
    expect(pickModel(ps)).toBe('a');
  });

  it('saute les modèles morts', () => {
    const ps = fakeState(['a', 'b', 'c']);
    ps.modelDead.add('a');
    expect(pickModel(ps)).toBe('b');
  });

  it('saute les modèles en cooldown', () => {
    const ps = fakeState(['a', 'b']);
    ps.modelCooldownUntil.set('a', Date.now() + 60_000);
    expect(pickModel(ps)).toBe('b');
  });

  it('répartit la charge : préfère le modèle le moins utilisé', () => {
    const ps = fakeState(['a', 'b']);
    // 'a' a déjà 10 requêtes dans la fenêtre, 'b' zéro → b choisi.
    ps.modelTimestamps.set('a', Array.from({ length: 10 }, () => Date.now()));
    expect(pickModel(ps)).toBe('b');
  });

  it('retourne null si tout est mort ou en pause', () => {
    const ps = fakeState(['a', 'b']);
    ps.modelDead.add('a');
    ps.modelCooldownUntil.set('b', Date.now() + 60_000);
    expect(pickModel(ps)).toBeNull();
  });
});

describe('initProviders (file de modèles)', () => {
  const keys = {
    openrouterApiKey: null, nvidiaApiKey: null, groqApiKey: 'k',
    geminiApiKey: 'g', sambanovaApiKey: null, cerebrasApiKey: null,
  };

  it('provider jamais testé → défaut + file curée', () => {
    initProviders({ ...keys, providerModels: {}, providerModelQueue: {} });
    // groq : 1 défaut + 3 curés = 4 ; gemini : 1 défaut + 4 curés = 5
    expect(totalModelCount()).toBe(9);
  });

  it('modèle découvert + queue → file = primary + queue + curés dédoublonnés', () => {
    initProviders({
      ...keys,
      groqApiKey: null, nvidiaApiKey: null, sambanovaApiKey: null, cerebrasApiKey: null, openrouterApiKey: null,
      providerModels: { gemini: 'gemini-2.5-flash' },
      providerModelQueue: { gemini: ['gemini-2.0-flash', 'custom-x'] },
    });
    // gemini : {2.5-flash, 2.0-flash, custom-x} + 4 curés (aucun doublon)
    // = 3 + 4 = 7 uniques
    expect(totalModelCount()).toBe(7);
  });

  it('provider testé sans succès (null) → ignoré', () => {
    initProviders({
      ...keys,
      providerModels: { gemini: null },
      providerModelQueue: {},
    });
    expect(totalModelCount()).toBe(4); // groq seul : 1 + 3
  });
});
