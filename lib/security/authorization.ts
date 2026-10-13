import type { AppSettings, UserProfile } from "@/lib/config";

/**
 * Authorization is by numeric Telegram user id.
 * Usernames are not accepted. Spreadsheet selection comes from server
 * configuration, never from a message. A later user directory can replace
 * the body of this function without changing its result shape.
 */
export function authorizeUser(
  telegramUserId: number,
  settings: Pick<AppSettings, "authorizedUserIds" | "google" | "currency" | "timezone">,
): UserProfile | null {
  if (!Number.isSafeInteger(telegramUserId)) return null;
  if (!settings.authorizedUserIds.includes(telegramUserId)) return null;
  return {
    profileId: String(telegramUserId),
    telegramUserId,
    spreadsheetId: settings.google?.spreadsheetId ?? "",
    currency: settings.currency,
    timezone: settings.timezone,
    preferredName: "",
    communicationPreference: "concise",
  };
}
