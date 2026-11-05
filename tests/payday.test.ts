import { describe, expect, it } from "vitest";

import type { BillRecord } from "@/lib/finance/bills";
import { billsBefore, forecastPayday, learnPayday, nextPayday, paydayText, resolvePayday, usualDailySpend, type Payday } from "@/lib/finance/payday";
import type { TransactionRecord } from "@/lib/finance/types";

const row = (date: string, type: "income" | "expense", amount: string, category: string, patch: Partial<TransactionRecord> = {}): TransactionRecord => ({
  transactionId: `${date}-${category}-${amount}`, createdAt: `${date}T12:00:00.000Z`, transactionDate: date, userId: "42", type, amount, currency: "GHS", category, description: category,
  paymentMethod: "", notes: "", status: "active", updatedAt: `${date}T12:00:00.000Z`, sourceUpdateId: "test", rowNumber: 0, ...patch,
});
const bill = (name: string, nextDate: string, amount: string | null, cadence: BillRecord["cadence"] = "monthly", patch: Partial<BillRecord> = {}): BillRecord => ({
  id: name, ownerId: "42", name, nextDate, amount, currency: "GHS", cadence, active: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...patch,
});

const salaries = [row("2026-08-25", "income", "4000.00", "Salary"), row("2026-09-25", "income", "4000.00", "Salary"), row("2026-10-23", "income", "4000.00", "Salary")];

describe("learning payday", () => {
  it("takes the most common day from salaries in different months, allowing for a weekend", () => {
    expect(learnPayday(salaries, "GHS", "2026-11-05")).toEqual({ day: 25, months: 3, lastPaid: "2026-10-23" });
  });

  it("needs two months, counts the biggest salary in a month, and ignores other currencies and deleted rows", () => {
    expect(learnPayday([salaries[0]], "GHS", "2026-11-05")).toBeNull();
    const noisy = [...salaries.slice(0, 2), row("2026-09-02", "income", "200.00", "Salary"), row("2026-10-10", "income", "4000.00", "Salary", { currency: "USD" }), row("2026-10-11", "income", "4000.00", "Salary", { status: "deleted" })];
    expect(learnPayday(noisy, "GHS", "2026-11-05")).toEqual({ day: 25, months: 2, lastPaid: "2026-09-25" });
  });

  it("learns nothing from salary that lands on very different days", () => {
    expect(learnPayday([row("2026-09-05", "income", "100.00", "Salary"), row("2026-10-25", "income", "100.00", "Salary")], "GHS", "2026-11-05")).toBeNull();
  });

  it("prefers what the person said over what was learned", () => {
    const learned = learnPayday(salaries, "GHS", "2026-11-05");
    expect(resolvePayday({ day: 28, regular: true }, learned)).toEqual({ status: "confirmed", day: 28 });
    expect(resolvePayday({ day: null, regular: false }, learned)).toEqual({ status: "none" });
    expect(resolvePayday(null, null)).toEqual({ status: "unknown" });
  });
});

describe("the next payday", () => {
  it("is this month's when it's still ahead, and next month's once it has passed", () => {
    expect(nextPayday(25, "2026-11-05")).toBe("2026-11-25");
    expect(nextPayday(25, "2026-11-25")).toBe("2026-11-25");
    expect(nextPayday(25, "2026-11-26")).toBe("2026-12-25");
    expect(nextPayday(25, "2026-12-26")).toBe("2027-01-25");
  });

  it("uses the last day of a short month", () => {
    expect(nextPayday(31, "2026-11-05")).toBe("2026-11-30");
    expect(nextPayday(30, "2027-02-01")).toBe("2027-02-28");
  });

  it("moves to next month when this month's salary already came in early", () => {
    expect(nextPayday(25, "2026-10-24", "2026-10-23")).toBe("2026-11-25");
    expect(nextPayday(25, "2026-11-05", "2026-10-23")).toBe("2026-11-25");
  });
});

describe("bills before payday", () => {
  it("counts each time a bill falls due from today up to the day before payday", () => {
    const bills = [bill("Rent", "2026-11-01", "1500.00"), bill("Fibre", "2026-11-12", "350.00"), bill("Gym", "2026-11-02", "50.00", "weekly"), bill("Paused", "2026-11-10", "99.00", "monthly", { active: false }), bill("Payday bill", "2026-11-25", "10.00")];
    const due = billsBefore(bills, "2026-11-05", "2026-11-25", "GHS");
    expect(due.map((item) => `${item.name} ${item.date}`)).toEqual(["Gym 2026-11-09", "Fibre 2026-11-12", "Gym 2026-11-16", "Gym 2026-11-23"]);
  });
});

describe("the forecast", () => {
  const confirmed: Payday = { status: "confirmed", day: 25 };
  const base = { payday: confirmed, today: "2026-11-15", currency: "GHS", bills: [bill("Rent", "2026-11-20", "1500.00"), bill("Fibre", "2026-11-18", "350.00"), bill("ECG", "2026-11-19", null)], transactions: [row("2026-11-10", "expense", "300.00", "Food")] };

  it("is what's in the accounts minus bills due before payday, spread over the days left", () => {
    const forecast = forecastPayday({ ...base, cash: { totalMinor: 2_670_00, missingCount: 0 } })!;
    expect(forecast).toMatchObject({ paydayDate: "2026-11-25", days: 10, billsMinor: 1_850_00, unpricedBills: 1, leftMinor: 820_00, perDayMinor: 82_00, usualDailyMinor: 10_00, tight: false });
    const text = paydayText(forecast, confirmed);
    expect(text).toContain("Payday is Wed 25 Nov, in 10 days.");
    expect(text).toContain("GH₵820.00 left after Fibre, Rent.");
    expect(text).toContain("about GH₵82.00 a day until payday");
    expect(text).toContain("One bill varies in amount");
    expect(text).toContain("about GH₵10.00 a day this past month");
  });

  it("is tight when bills before payday come to more than what's there", () => {
    const forecast = forecastPayday({ ...base, cash: { totalMinor: 1_000_00, missingCount: 0 } })!;
    expect(forecast).toMatchObject({ leftMinor: -850_00, perDayMinor: null, tight: true });
    expect(paydayText(forecast, confirmed)).toContain("GH₵850.00 more than the GH₵1,000.00 in your accounts");
  });

  it("never guesses a balance it doesn't have", () => {
    const forecast = forecastPayday({ ...base, cash: { totalMinor: null, missingCount: 1 } })!;
    expect(forecast.leftMinor).toBeNull();
    expect(paydayText(forecast, confirmed)).toContain("one of your accounts has no balance from a bank text");
  });

  it("asks to confirm a learned payday, and says when payday isn't known or isn't regular", () => {
    const learned: Payday = { status: "learned", day: 25, months: 3, lastPaid: "2026-10-23" };
    expect(paydayText(forecastPayday({ ...base, payday: learned, cash: { totalMinor: 2_000_00, missingCount: 0 } }), learned)).toContain("I took payday as the 25th from your salary in the last 3 months. Is that right?");
    expect(forecastPayday({ ...base, payday: { status: "unknown" }, cash: { totalMinor: 0, missingCount: 0 } })).toBeNull();
    expect(paydayText(null, { status: "unknown" })).toContain("I don't know your payday yet");
    expect(paydayText(null, { status: "none" })).toContain("don't have a regular payday");
  });

  it("averages only this currency's active spending over the past 30 days", () => {
    expect(usualDailySpend([row("2026-11-14", "expense", "60.00", "Food"), row("2026-10-01", "expense", "999.00", "Food"), row("2026-11-14", "expense", "9.00", "Food", { currency: "USD" })], "GHS", "2026-11-15")).toBe(2_00);
    expect(usualDailySpend([], "GHS", "2026-11-15")).toBeNull();
  });
});

describe("payday in chat", () => {
  const OWNER = "00000000-0000-4000-8000-000000000042";
  async function setup(salary = true) {
    const { MemoryFinanceStore } = await import("@/lib/finance/memory-store");
    const { MemoryBillStore } = await import("@/lib/finance/bills");
    const { MemoryPaydayStore } = await import("@/lib/finance/payday-store");
    const { profile } = await import("./helpers");
    const store = new MemoryFinanceStore(), bills = new MemoryBillStore(), paydays = new MemoryPaydayStore();
    if (salary) for (const date of ["2026-09-25", "2026-10-23"]) await store.appendTransaction({ ...row(date, "income", "4000.00", "Salary", { userId: OWNER }) });
    bills.bills.push(bill("Fibre", "2026-11-12", "350.00", "monthly", { ownerId: OWNER }));
    const ctx = { profile: profile(42, { profileId: OWNER }), store, bills, paydays, now: new Date("2026-11-05T15:00:00.000Z"), updateId: 1, chatId: 100,
      confirmTransactions: "auto" as const, pendingTtlMs: 600_000, createId: () => "id", createActionId: () => "action" };
    return { ctx, paydays };
  }

  it("answers from the learned payday and asks to confirm it, then saves what they say", async () => {
    const { handleAction } = await import("@/lib/finance/action-router");
    const { ctx, paydays } = await setup();
    const answer = await handleAction({ type: "get_payday_forecast" }, ctx);
    expect(answer.text).toContain("Payday is Wed 25 Nov, in 20 days.");
    expect(answer.text).toContain("Is that right?");
    expect((await handleAction({ type: "set_payday", day: 25 }, ctx)).text).toContain("payday is the 25th");
    expect(await paydays.get(OWNER)).toEqual({ day: 25, regular: true });
    expect((await handleAction({ type: "get_payday_forecast" }, ctx)).text).not.toContain("Is that right?");
    await handleAction({ type: "set_payday", day: null }, ctx);
    expect(await paydays.get(OWNER)).toEqual({ day: null, regular: false });
    expect((await handleAction({ type: "get_payday_forecast" }, ctx)).text).toContain("don't have a regular payday");
  });

  it("says how to set payday when there's no salary to learn from", async () => {
    const { handleAction } = await import("@/lib/finance/action-router");
    const { ctx } = await setup(false);
    expect((await handleAction({ type: "get_payday_forecast" }, ctx)).text).toContain("I don't know your payday yet");
  });
});
