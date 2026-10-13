import { describe, expect, it } from "vitest";

import { dueReminders, type ReminderCandidate } from "@/lib/reminders/due";

function candidate(overrides: Partial<ReminderCandidate> = {}): ReminderCandidate {
  return {
    ownerId: "hans",
    timezone: "Africa/Accra",
    chatId: 965699706,
    morningEnabled: true,
    commuteEnabled: true,
    eveningEnabled: true,
    morningMinute: 8 * 60,
    commuteMinute: 8 * 60 + 30,
    eveningMinute: 20 * 60,
    expenseRecordedToday: false,
    alreadySent: [],
    ...overrides,
  };
}

describe("reminder delivery", () => {
  it("sends a morning check-in once inside the local window", () => {
    const now = new Date("2026-10-11T08:05:00.000Z");
    const due = dueReminders([candidate()], now);
    expect(due.map((item) => item.kind)).toEqual(["morning"]);
    expect(due[0]?.localDate).toBe("2026-10-11");
    expect(dueReminders([candidate({ alreadySent: ["morning"] })], now)).toEqual([]);
  });

  it("skips commute and evening reminders after an expense, and skips people who never messaged", () => {
    const commute = new Date("2026-10-11T08:30:00.000Z");
    expect(dueReminders([candidate({ expenseRecordedToday: true })], commute)).toEqual([]);
    const evening = new Date("2026-10-11T20:00:00.000Z");
    expect(dueReminders([candidate({ chatId: null })], evening)).toEqual([]);
    expect(dueReminders([candidate({ expenseRecordedToday: false })], evening).map((item) => item.kind)).toEqual([
      "evening",
    ]);
  });
});
