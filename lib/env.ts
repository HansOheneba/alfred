import { ConfigError } from "@/lib/errors";
import {
  ALFRED_SUPABASE_HOST,
  ALFRED_SUPABASE_PROJECT_REF,
  ALFRED_SUPABASE_USER,
  DEFAULT_CURRENCY,
  DEFAULT_TIMEZONE,
  DEFAULT_MODEL,
  DEFAULT_STRONG_MODEL,
  type AppSettings,
  type ModelSettings,
  type GoogleSettings,
  type StudioSettings,
  type SupabaseSettings,
} from "@/lib/config";

function optional(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function assertTimeZone(timeZone: string): void {
  try {
    Intl.DateTimeFormat("en-US", { timeZone }).format(0);
  } catch {
    throw new ConfigError("APP_TIMEZONE is not a valid IANA time zone.");
  }
}

export function parseAuthorizedUserIds(value: string): number[] {
  if (!value.trim()) return [];
  const ids = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const numbers = ids.map((id) => {
    if (!/^\d+$/.test(id)) {
      throw new ConfigError("AUTHORIZED_TELEGRAM_USER_IDS must be numeric Telegram user IDs.");
    }
    const parsed = Number(id);
    if (!Number.isSafeInteger(parsed)) {
      throw new ConfigError("AUTHORIZED_TELEGRAM_USER_IDS contains an id that is too large.");
    }
    return parsed;
  });
  return [...new Set(numbers)];
}

export function normalizePrivateKey(value: string): string {
  let key = value.trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }
  return key.replace(/\\n/g, "\n");
}

const MODEL_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Claude settings. ANTHROPIC_API_KEY is required; the two model names have defaults. */
export function readModel(): ModelSettings | null {
  const apiKey = optional("ANTHROPIC_API_KEY");
  if (!apiKey) return null;
  const model = optional("ALFRED_MODEL") || DEFAULT_MODEL;
  const strongModel = optional("ALFRED_STRONG_MODEL") || DEFAULT_STRONG_MODEL;
  if (!MODEL_ID.test(model)) throw new ConfigError("ALFRED_MODEL contains unsupported characters.");
  if (!MODEL_ID.test(strongModel)) throw new ConfigError("ALFRED_STRONG_MODEL contains unsupported characters.");
  return { apiKey, model, strongModel };
}

function readGoogle(): GoogleSettings | null {
  const clientEmail = optional("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKeyRaw = optional("GOOGLE_PRIVATE_KEY");
  const spreadsheetId = optional("GOOGLE_SHEETS_SPREADSHEET_ID");
  if (!clientEmail && !privateKeyRaw && !spreadsheetId) return null;
  const missing = [
    !clientEmail ? "GOOGLE_SERVICE_ACCOUNT_EMAIL" : null,
    !privateKeyRaw ? "GOOGLE_PRIVATE_KEY" : null,
    !spreadsheetId ? "GOOGLE_SHEETS_SPREADSHEET_ID" : null,
  ].filter((item): item is string => Boolean(item));
  if (missing.length > 0) {
    throw new ConfigError(`Incomplete Google Sheets configuration: ${missing.join(", ")}`);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
    throw new ConfigError("GOOGLE_SERVICE_ACCOUNT_EMAIL is not an email address.");
  }
  if (!/^[a-zA-Z0-9-_]{20,128}$/.test(spreadsheetId)) {
    throw new ConfigError("GOOGLE_SHEETS_SPREADSHEET_ID is not a spreadsheet id.");
  }
  const privateKey = normalizePrivateKey(privateKeyRaw);
  if (!privateKey.includes("PRIVATE KEY")) {
    throw new ConfigError("GOOGLE_PRIVATE_KEY is not a PEM private key.");
  }
  return { clientEmail, privateKey, spreadsheetId };
}

function readSupabase(): SupabaseSettings | null {
  const urlValue = optional("SUPABASE_URL") || optional("NEXT_PUBLIC_SUPABASE_URL");
  const password = optional("SUPABASE_DB_PASSWORD");
  if (!urlValue && !password) return null;
  if (!urlValue) throw new ConfigError("Missing required environment variable: SUPABASE_URL");
  if (!password) throw new ConfigError("Missing required environment variable: SUPABASE_DB_PASSWORD");
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new ConfigError("SUPABASE_URL is not a URL.");
  }
  if (url.protocol !== "https:" || url.hostname !== `${ALFRED_SUPABASE_PROJECT_REF}.supabase.co`) {
    throw new ConfigError("SUPABASE_URL is not the Alfred project.");
  }
  return {
    projectRef: ALFRED_SUPABASE_PROJECT_REF,
    host: ALFRED_SUPABASE_HOST,
    user: ALFRED_SUPABASE_USER,
    database: "postgres",
    password,
  };
}

export function getDatabaseSettings(): SupabaseSettings {
  const supabase = readSupabase();
  if (!supabase) throw new ConfigError("Missing required environment variable: SUPABASE_URL");
  return supabase;
}

function readPreferences(): Pick<
  AppSettings,
  "timezone" | "currency" | "confirmTransactions" | "authorizedUserIds"
> {
  const timezone = optional("APP_TIMEZONE") || DEFAULT_TIMEZONE;
  assertTimeZone(timezone);
  const currency = (optional("DEFAULT_CURRENCY") || DEFAULT_CURRENCY).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ConfigError("DEFAULT_CURRENCY must be a 3-letter ISO code.");
  }
  const confirm = optional("CONFIRM_TRANSACTIONS") || "auto";
  if (confirm !== "auto" && confirm !== "always") {
    throw new ConfigError("CONFIRM_TRANSACTIONS must be auto or always.");
  }
  return {
    timezone,
    currency,
    confirmTransactions: confirm,
    authorizedUserIds: parseAuthorizedUserIds(optional("AUTHORIZED_TELEGRAM_USER_IDS")),
  };
}

export function getSettings(): AppSettings {
  const telegramBotToken = optional("TELEGRAM_BOT_TOKEN");
  const webhookSecret = optional("TELEGRAM_WEBHOOK_SECRET");
  if (!telegramBotToken) {
    throw new ConfigError("Missing required environment variable: TELEGRAM_BOT_TOKEN");
  }
  if (!webhookSecret) {
    throw new ConfigError("Missing required environment variable: TELEGRAM_WEBHOOK_SECRET");
  }
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(telegramBotToken)) {
    throw new ConfigError("TELEGRAM_BOT_TOKEN is not a Telegram bot token.");
  }
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(webhookSecret)) {
    throw new ConfigError(
      "TELEGRAM_WEBHOOK_SECRET must be 16–256 characters and use only letters, numbers, underscores, and hyphens.",
    );
  }

  return {
    telegramBotToken,
    webhookSecret,
    ai: readModel(),
    google: readGoogle(),
    supabase: readSupabase(),
    ...readPreferences(),
  };
}

export function isStudioEnabled(): boolean {
  return process.env.NODE_ENV === "development" || process.env.STUDIO_ENABLED === "true";
}

export function getStudioSettings(): StudioSettings {
  const ai = readModel();
  const supabase = readSupabase();
  if (!ai) throw new ConfigError("Missing required environment variable: ANTHROPIC_API_KEY");
  if (!supabase) throw new ConfigError("Missing required environment variable: SUPABASE_URL");
  const preferences = readPreferences();
  return { ai, google: readGoogle(), supabase, ...preferences };
}

export function readPublicStatus(): {
  telegram: boolean;
  ai: boolean;
  sheets: boolean;
  authorizationConfigured: boolean;
} {
  return {
    telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_WEBHOOK_SECRET),
    ai: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    sheets: Boolean(
      process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
        process.env.GOOGLE_PRIVATE_KEY &&
        process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
    ),
    authorizationConfigured: Boolean(process.env.AUTHORIZED_TELEGRAM_USER_IDS?.trim()),
  };
}
