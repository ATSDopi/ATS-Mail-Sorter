import type { AiProvider, Category } from "../types";

// ─── Providers ─────────────────────────────────────────────────────────

export type ApiKeyField =
  | "openrouterApiKey" | "nvidiaApiKey" | "groqApiKey"
  | "geminiApiKey" | "sambanovaApiKey" | "cerebrasApiKey";

export interface ProviderMeta {
  id: AiProvider;
  name: string;
  hint: string;
  placeholder: string;
  keyUrl: string;
  keyField: ApiKeyField;
}

export const PROVIDERS: ProviderMeta[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    hint: "20 RPM · 50 req/jour gratuit",
    placeholder: "sk-or-v1-…",
    keyUrl: "https://openrouter.ai/keys",
    keyField: "openrouterApiKey",
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    hint: "40 RPM",
    placeholder: "nvapi-…",
    keyUrl: "https://build.nvidia.com",
    keyField: "nvidiaApiKey",
  },
  {
    id: "groq",
    name: "Groq",
    hint: "30 RPM · 1000 req/jour",
    placeholder: "gsk_…",
    keyUrl: "https://console.groq.com/keys",
    keyField: "groqApiKey",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    hint: "15 RPM · 1000 req/jour",
    placeholder: "AIza…",
    keyUrl: "https://aistudio.google.com/apikey",
    keyField: "geminiApiKey",
  },
  {
    id: "sambanova",
    name: "SambaNova",
    hint: "20 RPM",
    placeholder: "sk-…",
    keyUrl: "https://cloud.sambanova.ai",
    keyField: "sambanovaApiKey",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    hint: "30 RPM · 1M tokens/jour",
    placeholder: "csk-…",
    keyUrl: "https://cloud.cerebras.ai",
    keyField: "cerebrasApiKey",
  },
];

export function providerName(id: string): string {
  return PROVIDERS.find((p) => p.id === id)?.name ?? id;
}

/** Nom de modèle raccourci : basename après « / », suffixe « :free » retiré. */
export function shortModel(id: string): string {
  const base = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return base.replace(/:free$/, "");
}

// ─── Catégories ────────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  favoris: "#facc15",
  travail: "#60a5fa",
  personnel: "#34d399",
  factures: "#fbbf24",
  promotions: "#f472b6",
  reseaux: "#a78bfa",
  notifications: "#22d3ee",
  spam: "#f87171",
  autre: "#94a3b8",
};

const FALLBACK_PALETTE = ["#fb923c", "#4ade80", "#38bdf8", "#e879f9", "#facc15", "#2dd4bf"];

export function categoryColor(categoryId: string | undefined, categories: Category[]): string {
  if (categoryId && CATEGORY_COLORS[categoryId]) return CATEGORY_COLORS[categoryId];
  // Catégories custom : couleur stable dérivée de la position dans la liste.
  const idx = categories.findIndex((c) => c.id === categoryId);
  return FALLBACK_PALETTE[((idx % FALLBACK_PALETTE.length) + FALLBACK_PALETTE.length) % FALLBACK_PALETTE.length];
}

// ─── Dates ─────────────────────────────────────────────────────────────

const RELATIVE = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });

/** « il y a 2 h », « hier », ou date courte si le parsing échoue. */
export function formatDate(raw: string): string {
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return raw;
  const diffSec = Math.round((t - Date.now()) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 60) return RELATIVE.format(diffSec, "second");
  if (abs < 3600) return RELATIVE.format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return RELATIVE.format(Math.round(diffSec / 3600), "hour");
  if (abs < 7 * 86400) return RELATIVE.format(Math.round(diffSec / 86400), "day");
  return new Intl.DateTimeFormat("fr", { day: "numeric", month: "short", year: "numeric" }).format(t);
}

/** Extrait le nom affichable d'un header From (« Jean <jean@x.fr> » → « Jean »). */
export function senderName(from: string): string {
  const m = from.match(/^\s*"?([^"<]+)"?\s*</);
  const name = m ? m[1].trim() : from.trim();
  return name || from;
}

export function senderAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return m ? m[1] : from;
}
