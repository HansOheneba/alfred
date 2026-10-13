export type ReminderKind = "morning" | "commute" | "evening";

export type ReminderCandidate = {
  ownerId: string;
  timezone: string;
  chatId: number | null;
  morningEnabled: boolean;
  commuteEnabled: boolean;
  eveningEnabled: boolean;
  morningMinute: number;
  commuteMinute: number;
  eveningMinute: number;
  expenseRecordedToday: boolean;
  alreadySent: ReminderKind[];
};

export type DueReminder = {
  ownerId: string;
  chatId: number;
  kind: ReminderKind;
  localDate: string;
};

const WINDOW_MINUTES = 15;

export function dueReminders(candidates: ReminderCandidate[], now: Date): DueReminder[] {
  const due: DueReminder[] = [];
  for (const candidate of candidates) {
    if (candidate.chatId == null) continue;
    const local = localParts(now, candidate.timezone);
    const minute = local.hour * 60 + local.minute;
    const kinds: Array<[ReminderKind, boolean, number, boolean]> = [
      ["morning", candidate.morningEnabled, candidate.morningMinute, false],
      ["commute", candidate.commuteEnabled, candidate.commuteMinute, true],
      ["evening", candidate.eveningEnabled, candidate.eveningMinute, true],
    ];
    for (const [kind, enabled, scheduled, skipWhenRecorded] of kinds) {
      if (!enabled || candidate.alreadySent.includes(kind)) continue;
      if (skipWhenRecorded && candidate.expenseRecordedToday) continue;
      if (minute < scheduled || minute >= scheduled + WINDOW_MINUTES) continue;
      due.push({ ownerId: candidate.ownerId, chatId: candidate.chatId, kind, localDate: local.date });
    }
  }
  return due;
}

export function reminderText(kind: ReminderKind, preferredName: string): string {
  const name = preferredName.trim();
  const hello = name ? `${name}, ` : "";
  if (kind === "morning") return `${hello}morning check-in. Tell me anything you spent or earned yesterday.`;
  if (kind === "commute") return `${hello}heading out? Send the fare if you haven't recorded it.`;
  return `${hello}evening review. What did you spend today?`;
}

function localParts(now: Date, timeZone: string): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const hour = Number(value("hour"));
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    hour: hour === 24 ? 0 : hour,
    minute: Number(value("minute")),
  };
}
