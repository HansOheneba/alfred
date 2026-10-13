import type { CommunicationPreference, UserProfile } from "@/lib/config";

export type TelegramLink = {
  ownerId: string;
  telegramUserId: number | null;
  chatId: number | null;
  lockedAt: string | null;
  preferredName: string;
  currency: string;
  timezone: string;
  communicationPreference: CommunicationPreference;
};

export type TelegramIdUpdate = "updated" | "locked" | "taken" | "invalid" | "missing";

export interface AccountDirectory {
  resolveTelegram(telegramUserId: number): Promise<UserProfile | null>;
  lockTelegram(telegramUserId: number, chatId: number, now: Date): Promise<void>;
}

export function profileFromLink(link: TelegramLink, spreadsheetId = ""): UserProfile {
  return {
    profileId: link.ownerId,
    telegramUserId: link.telegramUserId,
    spreadsheetId,
    currency: link.currency,
    timezone: link.timezone,
    preferredName: link.preferredName,
    communicationPreference: link.communicationPreference,
  };
}

export function canEditTelegramId(link: Pick<TelegramLink, "lockedAt">): boolean {
  return link.lockedAt == null;
}

export function parseTelegramUserId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

export function assignTelegramId(link: TelegramLink, telegramUserId: number): TelegramLink | "locked" | "invalid" {
  if (!canEditTelegramId(link)) return "locked";
  if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0) return "invalid";
  return { ...link, telegramUserId };
}

export function lockOnFirstMessage(link: TelegramLink, telegramUserId: number, chatId: number, now: Date): TelegramLink {
  if (link.telegramUserId !== telegramUserId || link.lockedAt) return link;
  return { ...link, lockedAt: now.toISOString(), chatId };
}

export class MemoryAccountDirectory {
  private readonly links: TelegramLink[];

  constructor(links: TelegramLink[]) {
    this.links = links.map((link) => ({ ...link }));
  }

  static fromIds(
    ids: number[],
    defaults: Pick<TelegramLink, "currency" | "timezone" | "communicationPreference">,
  ): MemoryAccountDirectory {
    return new MemoryAccountDirectory(
      ids.map((id) => ({
        ownerId: String(id),
        telegramUserId: id,
        chatId: null,
        lockedAt: null,
        preferredName: "",
        currency: defaults.currency,
        timezone: defaults.timezone,
        communicationPreference: defaults.communicationPreference,
      })),
    );
  }

  list(): TelegramLink[] {
    return this.links.map((link) => ({ ...link }));
  }

  async resolveTelegram(telegramUserId: number): Promise<UserProfile | null> {
    if (!Number.isSafeInteger(telegramUserId)) return null;
    const link = this.links.find((item) => item.telegramUserId === telegramUserId);
    return link ? profileFromLink(link) : null;
  }

  resolveOwner(ownerId: string): UserProfile | null {
    const link = this.links.find((item) => item.ownerId === ownerId);
    return link ? profileFromLink(link) : null;
  }

  async lockTelegram(telegramUserId: number, chatId: number, now: Date): Promise<void> {
    const link = this.links.find((item) => item.telegramUserId === telegramUserId);
    if (!link) return;
    const next = lockOnFirstMessage(link, telegramUserId, chatId, now);
    Object.assign(link, next);
  }

  updateTelegramId(ownerId: string, telegramUserId: number): TelegramIdUpdate {
    const link = this.links.find((item) => item.ownerId === ownerId);
    if (!link) return "missing";
    if (this.links.some((item) => item !== link && item.telegramUserId === telegramUserId)) return "taken";
    const next = assignTelegramId(link, telegramUserId);
    if (next === "locked" || next === "invalid") return next;
    Object.assign(link, next);
    return "updated";
  }
}
