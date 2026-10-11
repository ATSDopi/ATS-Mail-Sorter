export type AiProvider = 'openrouter' | 'nvidia' | 'groq' | 'gemini' | 'sambanova' | 'cerebras';

export interface Category {
  id: string;
  name: string;
  gmailLabel: string | null;
  archiveAfter: boolean;
}

export interface GmailTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number; // epoch seconds
  scope: string;
}

export interface Settings {
  googleClientId: string | null;
  googleClientSecret: string | null;
  oauthRedirectPort: number;
  aiProvider: AiProvider | null;
  openrouterApiKey: string | null;
  nvidiaApiKey: string | null;
  groqApiKey: string | null;
  geminiApiKey: string | null;
  sambanovaApiKey: string | null;
  cerebrasApiKey: string | null;
  aiModel: string | null;
  /**
   * Modèle auto-découvert par provider (rempli automatiquement).
   * - clé absente  → provider jamais testé → le modèle par défaut est utilisé.
   * - valeur null  → testé, aucun modèle valide → provider ignoré au tri.
   * - valeur string → modèle validé.
   */
  providerModels: Partial<Record<AiProvider, string | null>>;
  /**
   * Modèles de secours validés par provider (file de rotation).
   * Quand le modèle principal est rate-limité ou à court de quota,
   * on bascule sur le suivant de la liste (les quotas gratuits sont
   * par modèle → plusieurs modèles = plusieurs quotas sur une clé).
   */
  providerModelQueue: Partial<Record<AiProvider, string[]>>;
  batchSize: number;
  categories: Category[];
  gmailTokens: GmailTokens | null;
}

export interface EmailSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  unread: boolean;
  starred: boolean;
  category: string | null;
  appliedLabel: string | null;
}

export interface CategorizationOutput {
  category_id: string;
  confidence: number;
  reason: string;
}

export interface CategorizationResult {
  emailId: string;
  categoryId: string;
  categoryName: string;
  confidence: number;
  reason: string;
  appliedLabel: string | null;
  archived: boolean;
}

export interface GmailLabel {
  id: string;
  name: string;
}

/** Progression du tri envoyée au renderer via l'event `sort:progress`. */
export interface SortProgress {
  total: number;
  done: number;
  succeeded: number;
  failed: number;
  /** Mails ignorés volontairement (favoris, déjà triés). */
  skipped: number;
  /** Mails en échec retriable ré-enfilés (entre erreur et validé). */
  retryPending: number;
  currentEmail: string;
  lastCategory: string | null;
  startedAt: number;
  batchMode: boolean;
}

/** Échec d'un mail individuel pendant le tri (event `sort:error`). */
export interface SortError {
  emailId: string;
  error: string;
}

/** Mail ré-enfilé pour un nouvel essai (event `sort:retry`). */
export interface SortRetry {
  emailId: string;
  attempt: number;
  maxRetries: number;
}

/** Résultat du test unitaire d'un provider (bouton "Tester" des paramètres). */
export interface ProviderTestResult {
  provider: AiProvider;
  model: string | null;
  ok: boolean;
  latencyMs: number;
  error: string | null;
}
