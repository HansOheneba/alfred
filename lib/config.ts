export const LIMITS = {
  maxBodyBytes: 65_536,
  maxUserTextChars: 2_000,
  maxModelTokens: 900,
  aiTimeoutMs: 20_000,
  googleTimeoutMs: 15_000,
  pendingTtlMs: 15 * 60 * 1000,
  processingStaleMs: 45_000,
  rateLimit: 20,
  rateWindowMs: 60_000,
  maxTransactionsPerMessage: 10,
  maxHistory: 20,
  recentContext: 8,
  maxMinor: 999_999_999,
} as const;

export const DEFAULT_TIMEZONE = "Africa/Accra";
export const DEFAULT_CURRENCY = "GHS";
export const DASHBOARD_URL = "https://alfred.designtechie.com";

export type GoogleSettings = {
  clientEmail: string;
  privateKey: string;
  spreadsheetId: string;
};

/** Claude models Alfred calls: `model` for everyday turns, `strongModel` for turns that need more care. */
export type ModelSettings = {
  apiKey: string;
  model: string;
  strongModel: string;
};

export const DEFAULT_MODEL = "claude-haiku-5-5";
export const DEFAULT_STRONG_MODEL = "claude-sonnet-5-5";

export const ALFRED_SUPABASE_PROJECT_REF = "jcenaxceqynywmottkxu";
export const ALFRED_SUPABASE_HOST = "aws-0-eu-west-1.pooler.supabase.com";
export const ALFRED_SUPABASE_USER = "postgres.jcenaxceqynywmottkxu";

export type SupabaseSettings = {
  projectRef: typeof ALFRED_SUPABASE_PROJECT_REF;
  host: typeof ALFRED_SUPABASE_HOST;
  user: typeof ALFRED_SUPABASE_USER;
  database: "postgres";
  password: string;
};

export type AppSettings = {
  telegramBotToken: string;
  webhookSecret: string;
  ai: ModelSettings | null;
  google: GoogleSettings | null;
  supabase: SupabaseSettings | null;
  authorizedUserIds: number[];
  timezone: string;
  currency: string;
  confirmTransactions: "auto" | "always";
};

export type StudioSettings = {
  ai: ModelSettings;
  google: GoogleSettings | null;
  supabase: SupabaseSettings;
  authorizedUserIds: number[];
  timezone: string;
  currency: string;
  confirmTransactions: "auto" | "always";
};

export type CommunicationPreference = "concise" | "detailed";

export type UserProfile = {
  profileId: string;
  telegramUserId: number | null;
  spreadsheetId: string;
  currency: string;
  timezone: string;
  preferredName: string;
  communicationPreference: CommunicationPreference;
  /** Private guidance on tone for this person, from public.assistant_notes. */
  toneNote?: string;
};
