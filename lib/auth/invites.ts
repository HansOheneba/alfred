/**
 * Who may create an Alfred account. Sign-up is invite-only: an email must be
 * on ALFRED_INVITES. People who already have an account can always sign in.
 *
 * Format: comma-separated entries, each an email with an optional Telegram
 * user ID after a colon. The ID is linked to the account on its first
 * sign-in, so the person can use the Telegram bot straight away.
 *
 *   ALFRED_INVITES=friend@example.com:546068741,other@example.com
 */
export type Invite = { email: string; telegramUserId: number | null };

const EMAIL = /^[^\s@:,]+@[^\s@:,]+\.[^\s@:,]+$/;

export function parseInvites(value: string | undefined): Map<string, Invite> {
  const invites = new Map<string, Invite>();
  for (const entry of (value ?? "").split(",")) {
    const [rawEmail, rawId, ...rest] = entry.trim().split(":");
    const email = rawEmail?.trim().toLowerCase() ?? "";
    // A malformed entry is skipped rather than failing every sign-in.
    if (!EMAIL.test(email) || rest.length > 0) continue;
    const id = rawId?.trim() ?? "";
    const telegramUserId = /^\d{1,15}$/.test(id) && Number(id) > 0 ? Number(id) : null;
    invites.set(email, { email, telegramUserId });
  }
  return invites;
}

export function findInvite(email: string | null | undefined, value = process.env.ALFRED_INVITES): Invite | null {
  if (!email) return null;
  return parseInvites(value).get(email.trim().toLowerCase()) ?? null;
}

export const NOT_INVITED = "Alfred is invite-only for now. Ask the person who invited you to add this email.";
