import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { Settings, Category } from './types';

const SETTINGS_FILE = 'mail-sorter-settings.json';

const DEFAULT_CATEGORIES: Category[] = [
  { id: 'favoris', name: 'Favoris', gmailLabel: 'STARRED', archiveAfter: false },
  { id: 'travail', name: 'Travail', gmailLabel: null, archiveAfter: false },
  { id: 'personnel', name: 'Personnel', gmailLabel: null, archiveAfter: false },
  { id: 'factures', name: 'Factures', gmailLabel: null, archiveAfter: true },
  { id: 'promotions', name: 'Promotions', gmailLabel: null, archiveAfter: true },
  { id: 'reseaux', name: 'Réseaux sociaux', gmailLabel: null, archiveAfter: true },
  { id: 'notifications', name: 'Notifications', gmailLabel: null, archiveAfter: true },
  { id: 'spam', name: 'Spam', gmailLabel: null, archiveAfter: true },
  { id: 'autre', name: 'Autre', gmailLabel: null, archiveAfter: false },
];

function settingsPath(): string {
  return path.join(app.getPath('userData'), SETTINGS_FILE);
}

// ─── Chiffrement des secrets au repos ──────────────────────────────────
// Electron safeStorage utilise le coffre de l'OS (DPAPI sous Windows,
// Keychain macOS, libsecret Linux). Si indisponible (Linux sans
// libsecret), on stocke en clair avec un warning — jamais de crash.

const ENC_PREFIX = 'enc:v1:';

/** Champs de Settings chiffrés sur disque (clé → valeur string ou objet). */
const SECRET_STRING_FIELDS = [
  'googleClientSecret',
  'openrouterApiKey',
  'nvidiaApiKey',
  'groqApiKey',
  'geminiApiKey',
  'sambanovaApiKey',
  'cerebrasApiKey',
] as const;

let warnedNoEncryption = false;

function encryptionAvailable(): boolean {
  const ok = safeStorage.isEncryptionAvailable();
  if (!ok && !warnedNoEncryption) {
    warnedNoEncryption = true;
    console.warn('[store] safeStorage indisponible — secrets stockés en clair');
  }
  return ok;
}

function encryptString(plain: string): string {
  if (!encryptionAvailable()) return plain;
  return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64');
}

function decryptString(value: string): string {
  if (!value.startsWith(ENC_PREFIX)) return value;
  return safeStorage.decryptString(
    Buffer.from(value.slice(ENC_PREFIX.length), 'base64')
  );
}

/** Sérialise les secrets en version chiffrée avant écriture disque. */
function secretsToDisk(settings: Settings): Record<string, unknown> {
  const out: Record<string, unknown> = { ...settings };
  for (const field of SECRET_STRING_FIELDS) {
    const v = settings[field];
    out[field] = v ? encryptString(v) : null;
  }
  out.gmailTokens = settings.gmailTokens
    ? encryptString(JSON.stringify(settings.gmailTokens))
    : null;
  return out;
}

/** Déchiffre les secrets lus du disque (migration transparente du clair). */
function secretsFromDisk(raw: Record<string, unknown>): Record<string, unknown> {
  const out = { ...raw };
  for (const field of SECRET_STRING_FIELDS) {
    const v = out[field];
    if (typeof v === 'string' && v.startsWith(ENC_PREFIX)) {
      try {
        out[field] = decryptString(v);
      } catch (e) {
        console.warn(`[store] déchiffrement ${field} impossible — champ réinitialisé`, e);
        out[field] = null;
      }
    }
  }
  const tokens = out.gmailTokens;
  if (typeof tokens === 'string' && tokens.startsWith(ENC_PREFIX)) {
    try {
      out.gmailTokens = JSON.parse(decryptString(tokens));
    } catch (e) {
      console.warn('[store] déchiffrement gmailTokens impossible — reconnectez Gmail', e);
      out.gmailTokens = null;
    }
  }
  return out;
}

function defaultSettings(): Settings {
  return {
    googleClientId: null,
    googleClientSecret: null,
    oauthRedirectPort: 14250,
    aiProvider: null,
    openrouterApiKey: null,
    nvidiaApiKey: null,
    groqApiKey: null,
    geminiApiKey: null,
    sambanovaApiKey: null,
    cerebrasApiKey: null,
    aiModel: null,
    providerModels: {},
    providerModelQueue: {},
    batchSize: 20,
    categories: DEFAULT_CATEGORIES,
    gmailTokens: null,
  };
}

/** Fusionne les valeurs lues avec les défauts pour les champs manquants. */
function mergeSettings(raw: Partial<Settings> | null): Settings {
  const defaults = defaultSettings();
  if (!raw) return defaults;
  const merged: Settings = {
    ...defaults,
    ...raw,
    categories: raw.categories && raw.categories.length > 0 ? raw.categories : defaults.categories,
  };
  // Garantit que la catégorie Favoris existe toujours et est protégée.
  if (!merged.categories.find((c) => c.id === 'favoris')) {
    merged.categories.unshift({ id: 'favoris', name: 'Favoris', gmailLabel: 'STARRED', archiveAfter: false });
  }
  return merged;
}

function logLoadedSettings(merged: Settings, filePath: string): void {
  console.log('[store] config chargée depuis', filePath, ':', {
    openrouter: !!merged.openrouterApiKey,
    nvidia: !!merged.nvidiaApiKey,
    groq: !!merged.groqApiKey,
    gemini: !!merged.geminiApiKey,
    sambanova: !!merged.sambanovaApiKey,
    cerebras: !!merged.cerebrasApiKey,
    gmail: !!merged.gmailTokens,
    providersTestes: Object.keys(merged.providerModels ?? {}).length,
  });
}

export async function loadSettings(): Promise<Settings> {
  const filePath = settingsPath();
  for (const candidate of [filePath, path.join(app.getPath('userData'), 'config.json')]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
      // Le fichier peut contenir { "settings": {...} } ou {...} directement.
      const raw = parsed.settings ?? parsed;
      const merged = mergeSettings(secretsFromDisk(raw) as Partial<Settings>);
      logLoadedSettings(merged, candidate);
      return merged;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[store] config illisible:', candidate, e);
      }
    }
  }
  console.warn('[store] aucun fichier config trouvé, utilisation des défauts');
  return defaultSettings();
}

export async function saveSettings(settings: Settings): Promise<void> {
  const filePath = settingsPath();
  const data = JSON.stringify({ settings: secretsToDisk(settings) }, null, 2);
  // Écriture atomique : fichier temporaire puis rename, pour ne jamais
  // laisser un JSON tronqué si l'app est tuée en pleine écriture.
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next: Settings = { ...current, ...patch };
  await saveSettings(next);
  return next;
}
