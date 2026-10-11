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
  expiresAt: number;
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
  /** Modèle découvert par provider ; null = testé sans succès, absent = jamais testé. */
  providerModels: Partial<Record<AiProvider, string | null>>;
  /** Modèles de secours validés par provider (file de rotation quota). */
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

export interface SortProgress {
  total: number;
  done: number;
  succeeded: number;
  failed: number;
  /** Mails ignorés volontairement (favoris protégés, déjà triés). */
  skipped: number;
  /** Mails ré-enfilés pour un nouvel essai après échec. */
  retryPending?: number;
  currentEmail: string;
  lastCategory: string | null;
  startedAt?: number;
  batchMode?: boolean;
}

export interface SortError {
  emailId: string;
  error: string;
}

export interface SortRetry {
  emailId: string;
  attempt: number;
  maxRetries: number;
}

export interface ProviderTestResult {
  provider: AiProvider;
  model: string | null;
  ok: boolean;
  latencyMs: number;
  error: string | null;
}

interface MailSorterApi {
  settings: {
    get: () => Promise<Settings>;
    save: (settings: Settings) => Promise<Settings>;
    /** Re-teste chaque clé et reconstruit les files de modèles (primary + rotation). */
    discover: () => Promise<Settings>;
  };
  gmail: {
    connect: () => Promise<GmailTokens>;
    disconnect: () => Promise<boolean>;
    listEmails: (max?: number) => Promise<EmailSummary[]>;
    getBody: (id: string) => Promise<string>;
    listLabels: () => Promise<GmailLabel[]>;
    openMessage: (id: string) => Promise<boolean>;
  };
  ai: {
    categorizeOne: (id: string) => Promise<CategorizationResult>;
    categorizeBatch: (max?: number, dryRun?: boolean) => Promise<CategorizationResult[]>;
    categorizeAll: (dryRun?: boolean) => Promise<CategorizationResult[]>;
    cancelSort: () => Promise<boolean>;
    onSortProgress: (cb: (data: SortProgress) => void) => (() => void);
    onSortResult: (cb: (data: CategorizationResult) => void) => (() => void);
    onSortStart: (cb: (data: { total: number }) => void) => (() => void);
    onSortDone: (cb: (data: { total: number; succeeded: number }) => void) => (() => void);
    onSortCancelled: (cb: (data: { done: number; total: number }) => void) => (() => void);
    onSortProvider: (cb: (data: { provider: string; model: string; success: boolean; latencyMs: number; error?: string }) => void) => (() => void);
    onSortError: (cb: (data: SortError) => void) => (() => void);
    onSortRetry: (cb: (data: SortRetry) => void) => (() => void);
  };
  providers: {
    test: (provider: AiProvider) => Promise<ProviderTestResult>;
  };
  debug: {
    getLogs: () => Promise<string>;
    getProviderStats: () => Promise<string>;
    testProviders: () => Promise<string>;
  };
}

declare global {
  interface Window {
    mailSorter: MailSorterApi;
  }
}

export const api: MailSorterApi = window.mailSorter;
