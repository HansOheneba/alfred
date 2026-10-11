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

export type GoogleSettings = {
  clientEmail: string;
  privateKey: string;
  spreadsheetId: string;
};

export type DeepSeekSettings = {
  apiKey: string;
  model: string;
};

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
  deepseek: DeepSeekSettings | null;
  google: GoogleSettings | null;
  supabase: SupabaseSettings | null;
  authorizedUserIds: number[];
  timezone: string;
  currency: string;
  confirmTransactions: "auto" | "always";
};

export type StudioSettings = {
  deepseek: DeepSeekSettings;
  google: GoogleSettings | null;
  supabase: SupabaseSettings;
  authorizedUserIds: number[];
  timezone: string;
  currency: string;
  confirmTransactions: "auto" | "always";
};

export type UserProfile = {
  telegramUserId: number;
  spreadsheetId: string;
  currency: string;
  timezone: string;
};
