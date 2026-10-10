import { ipcMain, BrowserWindow, app, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { loadSettings, saveSettings, updateSettings } from './store';
import { startOAuthFlow, refreshAccessToken } from './oauth';
import { GmailClient, mapPool } from './gmail';
import {
  categorize,
  categorizeBatch,
  initProviders,
  providerConfigsCount,
  getProviderStats,
  onCategorizeAttempt,
  apiKeyFor,
  AI_PROVIDERS,
  DEFAULT_MODELS,
  onSortCancelCheck,
  type BatchEmailItem,
} from './ai';
import { discoverModels, testModel } from './ai-discovery';
import type {
  Settings, GmailTokens, EmailSummary, CategorizationResult,
  AiProvider, SortProgress, ProviderTestResult,
} from './types';

// --- Utilitaires ---

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Flag global d'annulation du tri en cours. */
let sortCancelled = false;
// Aborte les requêtes Gmail en vol pendant un tri (Arrêter = vraiment tout).
let sortAbort: AbortController | null = null;
// Le moteur IA lit ce flag à chaque boucle/attente → annulation immédiate,
// y compris pendant un cooldown ou une attente RPM.
onSortCancelCheck(() => sortCancelled);

/** Envoie un événement de progression à toutes les fenêtres. */
function sendProgress(event: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(event, data);
  }
}

const BATCH_SIZE = 8; // nombre de mails par requête IA

/** Calcule le nombre de workers IA parallèles selon les providers configurés. */
function aiConcurrency(): number {
  // Chaque provider a sa propre fenêtre RPM (et ses propres quotas par
  // modèle) → autant de workers que de providers, borné à 4.
  return Math.min(4, Math.max(1, providerConfigsCount()));
}

// ─── Validation des entrées IPC ─────────────────────────────────────────
// Le renderer est une frontend potentiellement compromise : on ne fait
// jamais confiance aux données reçues — allowlist de champs, coercion de
// types et bornes sur les nombres.

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeCategory(c: unknown): Settings['categories'][number] | null {
  if (typeof c !== 'object' || c === null) return null;
  const o = c as Record<string, unknown>;
  const id = strOrNull(o.id);
  const name = strOrNull(o.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    gmailLabel: strOrNull(o.gmailLabel),
    archiveAfter: o.archiveAfter === true,
  };
}

/** Construit un objet Settings propre à partir de données non fiables. */
function sanitizeSettings(input: unknown): Settings {
  const o = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const categories = Array.isArray(o.categories)
    ? o.categories.map(sanitizeCategory).filter((c): c is NonNullable<typeof c> => c !== null)
    : [];
  return {
    googleClientId: strOrNull(o.googleClientId),
    googleClientSecret: strOrNull(o.googleClientSecret),
    oauthRedirectPort: clampInt(o.oauthRedirectPort, 1024, 65535, 14250),
    aiProvider: null, // champ hérité, la sélection est automatique
    openrouterApiKey: strOrNull(o.openrouterApiKey),
    nvidiaApiKey: strOrNull(o.nvidiaApiKey),
    groqApiKey: strOrNull(o.groqApiKey),
    geminiApiKey: strOrNull(o.geminiApiKey),
    sambanovaApiKey: strOrNull(o.sambanovaApiKey),
    cerebrasApiKey: strOrNull(o.cerebrasApiKey),
    aiModel: null,
    providerModels: sanitizeProviderModels(o.providerModels),
    providerModelQueue: sanitizeProviderModelQueue(o.providerModelQueue),
    batchSize: clampInt(o.batchSize, 1, 500, 20),
    categories,
    gmailTokens: sanitizeTokens(o.gmailTokens),
  };
}

function sanitizeProviderModels(v: unknown): Settings['providerModels'] {
  if (typeof v !== 'object' || v === null) return {};
  const out: Settings['providerModels'] = {};
  for (const p of AI_PROVIDERS) {
    const model = (v as Record<string, unknown>)[p];
    if (model === null) out[p] = null;
    else if (typeof model === 'string' && model) out[p] = model;
  }
  return out;
}

function sanitizeProviderModelQueue(v: unknown): Settings['providerModelQueue'] {
  if (typeof v !== 'object' || v === null) return {};
  const out: Settings['providerModelQueue'] = {};
  for (const p of AI_PROVIDERS) {
    const arr = (v as Record<string, unknown>)[p];
    if (Array.isArray(arr)) {
      out[p] = arr.filter((m): m is string => typeof m === 'string' && m.length > 0).slice(0, 10);
    }
  }
  return out;
}

function sanitizeTokens(v: unknown): GmailTokens | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const accessToken = strOrNull(o.accessToken);
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: strOrNull(o.refreshToken),
    expiresAt: typeof o.expiresAt === 'number' && Number.isFinite(o.expiresAt) ? o.expiresAt : 0,
    scope: typeof o.scope === 'string' ? o.scope : '',
  };
}

function sanitizeMax(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return clampInt(v, -1, 10000, 20);
}

/** Providers dont la clé API a changé entre deux versions des settings. */
function changedProviders(prev: Settings, next: Settings): AiProvider[] {
  return AI_PROVIDERS.filter((p) => apiKeyFor(prev, p) !== apiKeyFor(next, p));
}

/** Test rapide de tous les providers configurés (1 requête test chacun, en parallèle). */
async function testAllProvidersQuick(settings: Settings): Promise<{ provider: AiProvider; ok: boolean }[]> {
  const tests = AI_PROVIDERS
    .map((p) => ({ provider: p, key: apiKeyFor(settings, p) }))
    .filter((t): t is { provider: AiProvider; key: string } => t.key !== null)
    .map((t) => ({ ...t, model: settings.providerModels?.[t.provider] ?? DEFAULT_MODELS[t.provider] }));

  return Promise.all(tests.map(async (t) => {
    try {
      const st = await testModel(t.provider, t.key, t.model, 10000);
      // 'ratelimit' (429) = provider vivant mais occupé → compte comme OK.
      const ok = st !== 'fail';
      if (!ok) console.warn(`[tri] test ${t.provider}/${t.model} → FAIL`);
      else if (st === 'ratelimit') console.warn(`[tri] test ${t.provider}/${t.model} → 429 (vivant, occupé)`);
      return { provider: t.provider, ok };
    } catch (e) {
      console.warn(`[tri] test ${t.provider}/${t.model} → ERROR: ${e}`);
      return { provider: t.provider, ok: false };
    }
  }));
}

/**
 * Traite les mails par lot (BATCH_SIZE mails par requête IA) avec un délai
 * entre chaque lot. Utilise getMessageMetadata (rapide) + snippet pour la
 * catégorisation. Failover automatique entre providers.
 * Les labels sont appliqués via messages/batchModify, regroupés par
 * (label, archive) et flushés par tranches de ~50 mails.
 */
async function categorizeWithProgress(
  refs: { id: string; threadId: string }[],
  client: GmailClient,
  settings: Settings,
  dryRun: boolean = false,
): Promise<CategorizationResult[]> {
  const results: CategorizationResult[] = [];
  const progress: SortProgress = {
    total: refs.length,
    done: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    currentEmail: '',
    lastCategory: null,
    startedAt: Date.now(),
    batchMode: true,
  };
  sortCancelled = false;

  // Callback : envoie le provider actif à l'UI en temps réel.
  onCategorizeAttempt((info) => {
    sendProgress('sort:provider', info);
  });

  // Initialise les providers IA pour le failover.
  initProviders(settings);
  if (providerConfigsCount() === 0) {
    throw new Error('Configuration IA incomplète — aucune clé API disponible');
  }

  // Test rapide des modèles configurés (1 requête test par provider).
  // Si tous échouent, lance un auto-discovery pour trouver des modèles valides.
  console.log('[tri] test préliminaire des providers…');
  const testResults = await testAllProvidersQuick(settings);
  const anyOk = testResults.some((r) => r.ok);
  if (!anyOk) {
    console.warn('[tri] tous les providers ont échoué au test préliminaire — auto-discovery…');
    sendProgress('sort:progress', { ...progress, lastCategory: 'Auto-discovery en cours…' });
    await autoDiscoverModels(settings);
    const updatedSettings = await loadSettings();
    Object.assign(settings, updatedSettings);
    initProviders(settings);
    if (providerConfigsCount() === 0) {
      throw new Error('Aucun provider IA fonctionnel après auto-discovery. Vérifiez vos clés API dans Paramètres.');
    }
    console.log('[tri] auto-discovery terminé, providers réinitialisés');
  } else {
    const okCount = testResults.filter((r) => r.ok).length;
    console.log(`[tri] ${okCount}/${testResults.length} provider(s) OK — démarrage du tri`);
  }

  // Récupère les labels Gmail existants pour détecter les mails déjà triés.
  const existingLabels = await client.listLabels();
  const categoryLabelIds = new Set<string>();
  for (const cat of settings.categories) {
    if (cat.id === 'favoris') continue;
    const labelName = cat.gmailLabel ?? cat.name;
    const found = existingLabels.find((l) => l.name.toLowerCase() === labelName.toLowerCase());
    if (found) categoryLabelIds.add(found.id);
  }
  console.log(`[tri] ${categoryLabelIds.size} label(s) de catégorie existant(s) pour skip`);

  // Cache des labels Gmail.
  const labelCache = new Map<string, string>();
  for (const lbl of existingLabels) {
    labelCache.set(lbl.name.toLowerCase(), lbl.id);
  }

  async function ensureLabelCached(name: string): Promise<string> {
    const key = name.toLowerCase();
    const cached = labelCache.get(key);
    if (cached) return cached;
    const id = await client.ensureLabel(name);
    labelCache.set(key, id);
    return id;
  }

  const aiCategories = settings.categories
    .filter((c) => c.id !== 'favoris')
    .map((c) => ({ id: c.id, name: c.name }));

  // Labels Gmail en attente d'application, regroupés par (labelId, archive).
  // On flush par tranches pour profiter de messages/batchModify.
  const pendingMods = new Map<string, { labelId: string; archive: boolean; ids: string[] }>();
  let pendingCount = 0;

  function queueLabel(ids: string[], labelId: string, archive: boolean): void {
    const key = `${labelId}|${archive ? 'a' : 'k'}`;
    const g = pendingMods.get(key);
    if (g) g.ids.push(...ids);
    else pendingMods.set(key, { labelId, archive, ids: [...ids] });
    pendingCount += ids.length;
  }

  async function flushLabels(): Promise<void> {
    if (pendingMods.size === 0 || sortCancelled) return;
    const groups = [...pendingMods.values()];
    pendingMods.clear();
    pendingCount = 0;
    await Promise.all(groups.map(async (g) => {
      const failed = await client.applyLabelBatch(g.ids, g.labelId, g.archive);
      for (const id of failed) {
        sendProgress('sort:error', { emailId: id, error: 'Échec application du label Gmail' });
      }
    }));
  }

  const recordSkip = (reason: string) => {
    progress.done++;
    progress.skipped++;
    progress.lastCategory = reason;
    sendProgress('sort:progress', { ...progress });
  };

  const recordResult = (br: { id: string; category_id: string; confidence: number; reason: string }) => {
    const cat = settings.categories.find((c) => c.id === br.category_id);
    if (!cat) {
      progress.done++;
      progress.failed++;
      sendProgress('sort:error', { emailId: br.id, error: `Catégorie inconnue: ${br.category_id}` });
      return;
    }
    const labelName = cat.gmailLabel ?? cat.name;
    const result: CategorizationResult = {
      emailId: br.id,
      categoryId: cat.id,
      categoryName: cat.name,
      confidence: br.confidence,
      reason: br.reason,
      appliedLabel: labelName,
      archived: cat.archiveAfter,
    };
    progress.done++;
    progress.succeeded++;
    progress.lastCategory = cat.name;
    sendProgress('sort:result', result);
    results.push(result);
    return result;
  };

  // Délai dynamique entre lots : départ 1,5s, descend vers 400ms si tout
  // va bien (le pacing réel est assuré par la fenêtre RPM par modèle).
  let dynamicDelay = 1500;
  let consecutiveBatchSuccesses = 0;

  // Applique les labels d'un résultat (regroupés via batchModify).
  const applyResult = async (br: { id: string; category_id: string }) => {
    if (dryRun) return;
    const cat = settings.categories.find((c) => c.id === br.category_id);
    if (!cat) return;
    const labelId = await ensureLabelCached(cat.gmailLabel ?? cat.name);
    queueLabel([br.id], labelId, cat.archiveAfter);
  };

  // Récupère les métadonnées d'un lot en parallèle (format=metadata).
  const fetchMetas = (batchRefs: { id: string; threadId: string }[]) =>
    mapPool(batchRefs, BATCH_SIZE, async (r) => {
      try {
        return { id: r.id, meta: await client.getMessageMetadata(r.id), error: null as unknown };
      } catch (e) {
        return { id: r.id, meta: null, error: e };
      }
    });

  // Filtre + catégorise un lot de métadonnées déjà récupérées.
  const processBatch = async (
    metas: { id: string; meta: (EmailSummary & { labelIds: string[] }) | null; error: unknown }[],
  ) => {
    const batchEmails: BatchEmailItem[] = [];
    for (const { id, meta, error } of metas) {
      if (!meta) {
        progress.done++;
        // Sur annulation les requêtes métadonnées s'abortent — ce ne sont
        // pas des échecs, juste des mails non traités.
        if (sortCancelled) continue;
        progress.failed++;
        console.warn('[tri] metadata illisible:', id, error);
        sendProgress('sort:error', { emailId: id, error: `Métadonnées illisibles: ${String(error).slice(0, 120)}` });
        continue;
      }
      if (meta.starred) { recordSkip('Favori (protégé)'); continue; }
      if (meta.labelIds.some((lid) => categoryLabelIds.has(lid))) { recordSkip('Déjà trié'); continue; }
      batchEmails.push({ id: meta.id, from: meta.from, subject: meta.subject, snippet: meta.snippet });
    }

    if (batchEmails.length === 0 || sortCancelled) return;

    try {
      const batchResults = await categorizeBatch(batchEmails, aiCategories);

      for (const br of batchResults) {
        recordResult(br);
        await applyResult(br);
      }

      const answeredIds = new Set(batchResults.map((r) => r.id));
      for (const be of batchEmails) {
        if (!answeredIds.has(be.id)) {
          progress.done++;
          progress.failed++;
          sendProgress('sort:error', { emailId: be.id, error: 'Pas de réponse IA pour ce mail' });
        }
      }

      consecutiveBatchSuccesses++;
      if (consecutiveBatchSuccesses >= 2) {
        dynamicDelay = Math.max(dynamicDelay * 0.7, 400); // min 400ms
      }
    } catch (e) {
      console.warn('batch error:', e);
      if (sortCancelled) return;
      // Fallback : mail par mail pour ce lot.
      for (const be of batchEmails) {
        if (sortCancelled) break;
        try {
          const out = await categorize({
            from: be.from,
            to: '',
            subject: be.subject,
            body: be.snippet,
            categories: aiCategories,
          });
          const br = { id: be.id, category_id: out.category_id, confidence: out.confidence, reason: out.reason };
          recordResult(br);
          await applyResult(br);
        } catch (e2) {
          console.warn('fallback error', be.id, e2);
          progress.done++;
          progress.failed++;
          sendProgress('sort:error', { emailId: be.id, error: String(e2) });
        }
      }
      dynamicDelay = Math.min(dynamicDelay * 1.5, 8_000);
      consecutiveBatchSuccesses = 0;
    }

    if (pendingCount >= 50) await flushLabels();
    sendProgress('sort:progress', { ...progress });

    // Log périodique avec ETA (toutes les ~24 mails traités).
    if (progress.done % 24 < BATCH_SIZE) {
      const elapsed = (Date.now() - progress.startedAt) / 1000;
      const rate = progress.done > 0 ? progress.done / elapsed : 0;
      const remaining = progress.total - progress.done;
      const eta = rate > 0 ? Math.round(remaining / rate) : 0;
      console.log(
        `[tri] ${progress.done}/${progress.total} (${Math.round(progress.done / progress.total * 100)}%) ` +
        `— ${rate.toFixed(1)} mail/s — ETA: ${Math.floor(eta / 60)}min${eta % 60}s ` +
        `— ignorés: ${progress.skipped} — ${getProviderStats()}`
      );
    }
  };

  // ── Pool de workers IA parallèles ──────────────────────────────────
  // Chaque worker pioche le lot suivant, prefetch ses métadonnées pendant
  // que l'appel IA du lot courant tourne (pipeline méta → IA → labels).
  let nextIdx = 0;
  const takeSlice = () => {
    if (nextIdx >= refs.length || sortCancelled) return null;
    const s = refs.slice(nextIdx, nextIdx + BATCH_SIZE);
    nextIdx += s.length;
    return s;
  };

  const concurrency = aiConcurrency();
  console.log(`[tri] ${concurrency} worker(s) IA en parallèle, lot de ${BATCH_SIZE} mails`);

  const workers = Array.from({ length: concurrency }, async () => {
    let slice = takeSlice();
    let prefetched = slice ? fetchMetas(slice) : null;
    while (prefetched) {
      const metas = await prefetched;
      const nextSlice = takeSlice();
      prefetched = nextSlice ? fetchMetas(nextSlice) : null;
      await processBatch(metas);
      if (sortCancelled) break;
      if (prefetched) await sleep(dynamicDelay);
    }
  });
  try {
    await Promise.all(workers);
  } catch (e) {
    // AbortError sur annulation → propage silencieusement ; le reste = bug réel.
    if (!sortCancelled) throw e;
  }

  if (!sortCancelled) await flushLabels();
  else sendProgress('sort:cancelled', { done: progress.done, total: progress.total });

  return results;
}

/**
 * Auto-discovery : pour chaque provider demandé (tous si `only` absent),
 * découvre le meilleur modèle valide et écrit le résultat dans
 * settings.providerModels — null explicite si rien ne fonctionne, pour que
 * le provider soit ignoré au tri plutôt que retesté en boucle.
 */
async function autoDiscoverModels(settings: Settings, only?: AiProvider[]): Promise<void> {
  const targets = only ?? AI_PROVIDERS;
  console.log('[IA] auto-discovery : démarrage pour', targets.join(', ') || 'aucun');

  const providerModels = { ...(settings.providerModels ?? {}) };
  const providerModelQueue = { ...(settings.providerModelQueue ?? {}) };
  await Promise.all(targets.map(async (provider) => {
    const key = apiKeyFor(settings, provider);
    if (!key) {
      delete providerModels[provider];
      delete providerModelQueue[provider];
      return;
    }
    const { primary, queue } = await discoverModels(provider, key);
    if (primary === undefined) {
      // Non concluant (rate-limit) → retombe sur « jamais testé » :
      // le runtime utilisera défaut + file curée.
      delete providerModels[provider];
      delete providerModelQueue[provider];
      return;
    }
    providerModels[provider] = primary;
    providerModelQueue[provider] = queue;
  }));

  await updateSettings({ providerModels, providerModelQueue });
  console.log('[IA] auto-discovery terminé:', JSON.stringify(providerModels));
}

async function ensureValidTokens(): Promise<{ tokens: GmailTokens; settings: Settings }> {
  const settings = await loadSettings();
  if (!settings.gmailTokens) throw new Error('Gmail non connecté. Lancez la connexion d\'abord.');
  let tokens = settings.gmailTokens;
  const now = Math.floor(Date.now() / 1000);
  if (tokens.expiresAt - now < 60) {
    if (!tokens.refreshToken) throw new Error('Token expiré sans refresh token — reconnectez Gmail.');
    const clientId = settings.googleClientId ?? '';
    const clientSecret = settings.googleClientSecret ?? '';
    tokens = await refreshAccessToken(clientId, clientSecret, tokens.refreshToken);
    await updateSettings({ gmailTokens: tokens });
  }
  return { tokens, settings };
}

export function registerIpc(): void {
  ipcMain.handle('settings:get', async () => loadSettings());

  ipcMain.handle('settings:save', async (_e, raw: unknown) => {
    const prev = await loadSettings();
    const clean = sanitizeSettings(raw);
    await saveSettings(clean);

    // Auto-discovery : relance seulement si une clé API a changé
    // (évite de retester tous les modèles à chaque save de catégories).
    const changed = changedProviders(prev, clean);
    const keysChanged = changed.some((p) => apiKeyFor(clean, p) !== null);
    if (keysChanged) {
      autoDiscoverModels(clean, changed).catch((e) => {
        console.warn('[IA] auto-discovery échoué:', e);
      });
    }
    // Si une clé a été retirée, nettoie ses entrées providerModels/queue.
    const removed = changed.filter((p) => apiKeyFor(clean, p) === null);
    if (removed.length > 0) {
      const providerModels = { ...clean.providerModels };
      const providerModelQueue = { ...clean.providerModelQueue };
      for (const p of removed) {
        delete providerModels[p];
        delete providerModelQueue[p];
      }
      await updateSettings({ providerModels, providerModelQueue });
    }

    return loadSettings();
  });

  // Re-découverte manuelle des modèles : re-teste chaque clé configurée et
  // reconstruit les files de rotation (primary + queue). Utile quand les
  // catalogues des providers ont changé depuis le premier test.
  ipcMain.handle('settings:discover', async () => {
    const settings = await loadSettings();
    const withKeys = AI_PROVIDERS.filter((p) => apiKeyFor(settings, p) !== null);
    await autoDiscoverModels(settings, withKeys);
    return loadSettings();
  });

  ipcMain.handle('gmail:connect', async () => {
    const s = await loadSettings();
    if (!s.googleClientId || !s.googleClientSecret) {
      throw new Error('Renseignez Google Client ID et Secret dans les paramètres avant de connecter.');
    }
    const port = s.oauthRedirectPort ?? 14250;
    const tokens = await startOAuthFlow(s.googleClientId, s.googleClientSecret, port);
    await updateSettings({ gmailTokens: tokens });
    return tokens;
  });

  ipcMain.handle('gmail:disconnect', async () => {
    await updateSettings({ gmailTokens: null });
    return true;
  });

  ipcMain.handle('gmail:listEmails', async (_e, rawMax?: unknown) => {
    const { tokens } = await ensureValidTokens();
    const client = new GmailClient(tokens);
    const s = await loadSettings();
    const max = sanitizeMax(rawMax);
    // max=0 ou undefined → utilise batchSize ; max<0 → tous les mails
    const limit = max !== undefined ? max : (s.batchSize ?? 20);
    const refs = await client.listInbox(limit);
    // Utilise format=metadata (headers seulement) en parallèle → 5-10x plus rapide.
    const out = await mapPool(refs, 8, async (r) => {
      try {
        return await client.getMessageMetadata(r.id);
      } catch (e) {
        console.warn('skip message', r.id, e);
        return null;
      }
    });
    return out.filter((m): m is EmailSummary & { labelIds: string[] } => m !== null);
  });

  ipcMain.handle('gmail:getBody', async (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) throw new Error('id de mail invalide');
    const { tokens } = await ensureValidTokens();
    const client = new GmailClient(tokens);
    return client.getMessageBody(id);
  });

  ipcMain.handle('gmail:listLabels', async () => {
    const { tokens } = await ensureValidTokens();
    const client = new GmailClient(tokens);
    return client.listLabels();
  });

  // Ouvre le mail dans Gmail (navigateur système).
  ipcMain.handle('gmail:openMessage', async (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) throw new Error('id de mail invalide');
    await shell.openExternal(`https://mail.google.com/mail/u/0/#all/${encodeURIComponent(id)}`);
    return true;
  });

  ipcMain.handle('ai:categorizeOne', async (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) throw new Error('id de mail invalide');
    const { tokens, settings } = await ensureValidTokens();
    sortAbort = new AbortController();
    const client = new GmailClient(tokens, sortAbort.signal);

    initProviders(settings);
    if (providerConfigsCount() === 0) {
      throw new Error('Aucune clé API configurée. Renseignez au moins une clé dans les paramètres.');
    }

    const msg = await client.getMessage(id);

    // PROTECTION FAVORIS : les mails starred sont intouchables.
    if (msg.starred) {
      return {
        emailId: id,
        categoryId: 'favoris',
        categoryName: 'Favoris',
        confidence: 1.0,
        reason: 'Mail favori — protégé par l\'étoile Gmail',
        appliedLabel: null,
        archived: false,
      } as CategorizationResult;
    }

    // Récupère les labels pour vérifier si déjà trié.
    const existingLabels = await client.listLabels();
    const categoryLabelIds = new Set<string>();
    for (const cat of settings.categories) {
      if (cat.id === 'favoris') continue;
      const labelName = cat.gmailLabel ?? cat.name;
      const found = existingLabels.find((l) => l.name.toLowerCase() === labelName.toLowerCase());
      if (found) categoryLabelIds.add(found.id);
    }
    const hasCategoryLabel = msg.labelIds.some((lid) => categoryLabelIds.has(lid));
    if (hasCategoryLabel) {
      return {
        emailId: id,
        categoryId: 'autre',
        categoryName: 'Déjà trié',
        confidence: 1.0,
        reason: 'Mail déjà catégorisé (label de catégorie présent)',
        appliedLabel: null,
        archived: false,
      } as CategorizationResult;
    }

    const aiCategories = settings.categories
      .filter((c) => c.id !== 'favoris')
      .map((c) => ({ id: c.id, name: c.name }));
    const out = await categorize({
      from: msg.from,
      to: msg.to,
      subject: msg.subject,
      body: msg.bodyText,
      categories: aiCategories,
    });

    const cat = settings.categories.find((c) => c.id === out.category_id);
    if (!cat) throw new Error(`Catégorie ${out.category_id} introuvable`);

    const labelName = cat.gmailLabel ?? cat.name;
    const labelId = await client.ensureLabel(labelName);
    await client.applyLabel(id, labelId, cat.archiveAfter);

    const result: CategorizationResult = {
      emailId: id,
      categoryId: cat.id,
      categoryName: cat.name,
      confidence: out.confidence,
      reason: out.reason,
      appliedLabel: labelName,
      archived: cat.archiveAfter,
    };
    return result;
  });

  ipcMain.handle('ai:categorizeBatch', async (_e, rawMax?: unknown, dryRun?: unknown) => {
    const { tokens, settings } = await ensureValidTokens();
    sortAbort = new AbortController();
    const client = new GmailClient(tokens, sortAbort.signal);
    try {
      const max = sanitizeMax(rawMax);
      const limit = max !== undefined ? max : (settings.batchSize ?? 20);
      const refs = await client.listInbox(limit);
      sendProgress('sort:start', { total: refs.length });
      const results = await categorizeWithProgress(refs, client, settings, dryRun === true);
      sendProgress('sort:done', { total: refs.length, succeeded: results.length });
      return results;
    } finally {
      sortAbort = null;
    }
  });

  // Trie TOUS les mails de la boîte de réception (pagination incluse).
  ipcMain.handle('ai:categorizeAll', async (_e, dryRun?: unknown) => {
    const { tokens, settings } = await ensureValidTokens();
    sortAbort = new AbortController();
    const client = new GmailClient(tokens, sortAbort.signal);
    try {
      const refs = await client.listInbox(0); // 0 = tous
      sendProgress('sort:start', { total: refs.length });
      const results = await categorizeWithProgress(refs, client, settings, dryRun === true);
      sendProgress('sort:done', { total: refs.length, succeeded: results.length });
      return results;
    } finally {
      sortAbort = null;
    }
  });

  // Annule le tri en cours : flag IA + avorte les requêtes Gmail en vol.
  ipcMain.handle('ai:cancelSort', async () => {
    sortCancelled = true;
    sortAbort?.abort();
    console.log('[tri] annulation demandée par l\'utilisateur');
    return true;
  });

  // Teste UN provider configuré (bouton "Tester" des paramètres).
  ipcMain.handle('providers:test', async (_e, raw: unknown): Promise<ProviderTestResult> => {
    const provider = (typeof raw === 'string' ? raw : '') as AiProvider;
    if (!AI_PROVIDERS.includes(provider)) {
      throw new Error(`provider inconnu: ${String(raw)}`);
    }
    const settings = await loadSettings();
    const key = apiKeyFor(settings, provider);
    if (!key) {
      return { provider, model: null, ok: false, latencyMs: 0, error: 'Aucune clé API configurée' };
    }
    const model = settings.providerModels?.[provider] ?? DEFAULT_MODELS[provider];
    const start = Date.now();
    try {
      const st = await testModel(provider, key, model, 15000);
      const latencyMs = Date.now() - start;
      const ok = st === 'ok';
      return {
        provider, model, ok, latencyMs,
        error: ok ? null : st === 'ratelimit' ? 'Rate-limit — modèle valide mais occupé, réessayez' : 'Le modèle ne répond pas',
      };
    } catch (e) {
      return { provider, model, ok: false, latencyMs: Date.now() - start, error: String(e).slice(0, 200) };
    }
  });

  // Récupère les dernières lignes du fichier de log.
  ipcMain.handle('debug:getLogs', async () => {
    try {
      const logPath = path.join(app.getPath('userData'), 'mail-sorter.log');
      const data = fs.readFileSync(logPath, 'utf8');
      const lines = data.split('\n').filter(Boolean);
      return lines.slice(-200).join('\n');
    } catch (e) {
      return `Erreur lecture log: ${e}`;
    }
  });

  // Récupère les stats des providers IA en temps réel.
  ipcMain.handle('debug:getProviderStats', async () => {
    return getProviderStats();
  });

  // Teste tous les providers configurés et renvoie un rapport.
  ipcMain.handle('debug:testProviders', async () => {
    const settings = await loadSettings();
    const tests = AI_PROVIDERS
      .map((p) => ({ provider: p, key: apiKeyFor(settings, p) }))
      .filter((t): t is { provider: AiProvider; key: string } => t.key !== null)
      .map((t) => ({ ...t, model: settings.providerModels?.[t.provider] ?? DEFAULT_MODELS[t.provider] }));

    const results: { provider: string; model: string; status: string; latency?: number; error?: string }[] = [];
    for (const t of tests) {
      const start = Date.now();
      try {
        const st = await testModel(t.provider, t.key, t.model, 15000);
        const latency = Date.now() - start;
        results.push({
          provider: t.provider, model: t.model,
          status: st === 'ok' ? 'OK' : st === 'ratelimit' ? 'RATE-LIMIT' : 'FAIL',
          latency,
        });
      } catch (e) {
        results.push({ provider: t.provider, model: t.model, status: 'ERROR', error: String(e).slice(0, 100) });
      }
    }

    return results.map((r) =>
      `${r.provider.padEnd(12)} ${r.model.padEnd(35)} ${r.status}${r.latency ? ` (${r.latency}ms)` : ''}${r.error ? ` — ${r.error}` : ''}`
    ).join('\n');
  });
}
