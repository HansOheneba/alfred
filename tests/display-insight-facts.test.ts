import { describe, expect, it } from "vitest";
import { detectRenewalCandidates, renewalGroupForTransaction } from "@/lib/finance/bill-renewals";
import { buildInsights, type InsightInput } from "@/lib/finance/insights";
import { buildDisplayInsightFacts, buildDisplayRenewalFacts, comparableInsightRange, displayRenewalGroup, formatDisplayInsights, formatDisplayRenewals } from "@/lib/finance/display-insight-facts";
import { addDays } from "@/lib/finance/dates";
import type { BillRecord } from "@/lib/finance/bills";
import type { BudgetRecord, TransactionRecord } from "@/lib/finance/types";

const OWNER = "fictional-facts-owner";
const row = (id: string, patch: Partial<TransactionRecord> = {}): TransactionRecord => ({ transactionId: id, createdAt: "2026-11-01T12:00:00Z", transactionDate: "2026-11-01", userId: OWNER, type: "expense", amount: "10.00", currency: "GHS", category: "Food", description: `Fictional ${id}`, paymentMethod: "Fictional cash", notes: "", status: "active", updatedAt: "2026-11-01T12:00:00Z", sourceUpdateId: id, rowNumber: 0, ...patch });
const budget = (category: string, amount = "100.00", patch: Partial<BudgetRecord> = {}): BudgetRecord => ({ budgetId: `fictional-budget:${category}`, userId: OWNER, period: "2026-11", category, amount, currency: "GHS", createdAt: "", updatedAt: "", rowNumber: 0, ...patch });
const bill = (name: string): BillRecord => ({ id: `fictional-bill:${name}`, ownerId: OWNER, name, nextDate: "2026-12-01", amount: "10.00", currency: "GHS", cadence: "monthly", active: true, createdAt: "", updatedAt: "" });
const input = (transactions: TransactionRecord[], patch: Partial<InsightInput> = {}): InsightInput => ({ userId: OWNER, currency: "GHS", range: { start: "2026-11-01", end: "2026-11-30" }, today: "2026-11-05", transactions, budgets: [], ...patch });
function insightParity(value: InsightInput) {
  const before = structuredClone(value), facts = buildDisplayInsightFacts(value), snapshot = structuredClone(facts);
  expect(formatDisplayInsights(facts, value.budgets)).toEqual(buildInsights(value));
  expect(facts).toEqual(snapshot); expect(value).toEqual(before);
  return facts;
}
function renewalParity(transactions: TransactionRecord[], savedBills: BillRecord[] = [], today = "2026-11-05", currency = "GHS") {
  const before = structuredClone({ transactions, savedBills }), facts = buildDisplayRenewalFacts(transactions, savedBills, today, currency), snapshot = structuredClone(facts);
  expect(formatDisplayRenewals(facts, today, currency)).toEqual(detectRenewalCandidates(transactions, savedBills, today, currency));
  expect(facts).toEqual(snapshot); expect({ transactions, savedBills }).toEqual(before);
  expect(facts.every(group => group.recentDates.length <= 4 && group.recentPayments.length <= 4)).toBe(true);
  return facts;
}

describe("compact display insight facts", () => {
  it("retains signed adjustments, tax/fee rows, mixed currencies, deleted/foreign rows and fresh budget math", () => {
    const transactions = [
      row("big", { amount: "200.00", category: "Utilities", description: "Fictional main bill" }),
      row("share", { amount: "-50.00", category: "Utilities", description: "Fictional linked adjustment", transactionDate: "2026-11-02" }),
      row("transport", { amount: "80.00", category: "Transport", transactionDate: "2026-11-03" }),
      row("fee-1", { amount: "1.00", category: "Fees" }), row("fee-2", { amount: "0.50", category: "Fees" }),
      row("tax", { amount: "0.25", category: "Taxes" }), row("savings", { amount: "15.00", category: "Savings" }),
      row("income", { type: "income", amount: "250.00", category: "Salary" }),
      row("last-month", { transactionDate: "2026-10-02", amount: "90.00", category: "Utilities" }),
      row("future-month", { transactionDate: "2026-12-01", amount: "999.00" }),
      row("different-currency", { currency: "USD", amount: "999.00" }),
      row("deleted", { status: "deleted", amount: "999.00" }), row("other-owner", { userId: "other-fictional-owner", amount: "999.00" }),
    ];
    const facts = insightParity(input(transactions, { budgets: [budget("Utilities", "100.00"), budget("Transport", "100.00"), budget("Food", "100.00")] }));
    expect(facts).toMatchObject({ expenseCount: 7, spentMinor: 24675, incomeMinor: 25000, fees: { count: 2, minor: 150 } });
    expect(formatDisplayInsights(facts, [budget("Utilities", "1000.00")])).toContain("Utilities budget is on track: GH₵850.00 left.");
    expect(JSON.stringify(facts)).not.toMatch(/sourceUpdateId|paymentMethod|createdAt|notes/);
  });

  it("preserves repeat first-label and equal-amount tie ordering", () => {
    const transactions = [
      ...["  First Label  ", "FIRST LABEL", "first label"].map((description, i) => row(`first:${i}`, { description, amount: "5.00" })),
      ...["Second Label", "second label", " SECOND LABEL "].map((description, i) => row(`second:${i}`, { description, amount: "5.00" })),
      ...[0, 1, 2].map(i => row(`excluded-fee:${i}`, { description: "Same fee", amount: "100.00", category: "Fees" })),
    ];
    const facts = insightParity(input(transactions));
    expect(facts.repeats.map(group => group.description)).toEqual(["First Label", "Second Label"]);
    expect(facts.biggest?.description).toBe("Same fee");
    expect(facts.categories.find(group => group.category === "Food")?.biggest?.description).toBe("  First Label  ");
  });

  it.each([
    ["2026-11-05", { start: "2026-10-01", end: "2026-10-05" }],
    ["2026-11-30", { start: "2026-10-01", end: "2026-10-31" }],
    ["2026-10-31", { start: "2026-10-01", end: "2026-10-31" }],
  ])("keeps elapsed/full-month comparisons at %s", (today, expected) => {
    expect(comparableInsightRange({ start: "2026-11-01", end: "2026-11-30" }, today)).toEqual(expected);
    insightParity(input([row("now"), row("previous", { transactionDate: "2026-10-15" })], { today }));
  });

  it("handles empty/income-only, zero and negative totals without creating new advice", () => {
    for (const transactions of [[], [row("income", { type: "income" })], [row("zero", { amount: "0.00" })], [row("negative", { amount: "-25.00" })]]) {
      insightParity(input(transactions, { budgets: [budget("Food", "0.00")] }));
    }
  });

  it("matches the unchanged insight oracle across 256 seeded fictional histories and calendar windows", () => {
    const category = ["Food", "Transport", "Fees", "Taxes", "Savings", "Utilities", "Rent & home", "Fictional custom"];
    const descriptions = [" First purchase ", "FIRST PURCHASE", "second purchase", "Third purchase", "Fictional tax", "Repeated sample", " repeated SAMPLE "];
    const ranges = [{ start: "2026-11-01", end: "2026-11-30" }, { start: "2026-10-15", end: "2026-11-05" }, { start: "2024-02-01", end: "2024-02-29" }, { start: "2026-01-01", end: "2026-01-31" }];
    for (let seed = 0; seed < 256; seed++) {
      let state = seed + 1; const random = (max: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % max; };
      const range = ranges[seed % ranges.length], today = addDays(range.start, seed % 40 - 4);
      const transactions = Array.from({ length: 120 }, (_, n) => row(`seed:${seed}:${n}`, {
        transactionDate: addDays(range.start, random(90) - 40), amount: ((random(8000) - 900) / 100).toFixed(2),
        category: category[random(category.length)], description: descriptions[random(descriptions.length)],
        status: random(13) === 0 ? "deleted" : "active", currency: random(9) === 0 ? "USD" : "GHS", type: random(5) === 0 ? "income" : "expense", userId: random(17) === 0 ? "other-fictional-owner" : OWNER,
      }));
      const budgets = category.map((item, index) => budget(item, ((seed + index * 11) % 190).toFixed(2), { period: range.start.slice(0, 7) }));
      insightParity(input(transactions, { range, today, budgets }));
    }
  });
});

describe("compact display renewal facts", () => {
  it("exports the exact existing classifier with a normalized saved-name key", () => {
    expect(displayRenewalGroup({ description: "NETFLIX bill", category: "Food" })).toEqual({ id: "netflix", name: "Netflix", nameKey: "netflix" });
    expect(displayRenewalGroup({ description: "  Fictional rent ", category: "Rent & home" })).toEqual({ id: "fictional rent", name: "Fictional rent", nameKey: "fictional rent" });
    expect(displayRenewalGroup({ description: "", category: "Utilities" })).toBeNull();
    expect(renewalGroupForTransaction({ description: "Sample purchase", category: "Food" })).toBeNull();
  });

  it("preserves monthly/yearly/weekly schedules and month-end anchors", () => {
    renewalParity([
      ...["2026-08-31", "2026-09-30", "2026-10-31"].map((date, i) => row(`monthly:${i}`, { transactionDate: date, description: "Netflix", amount: "12.00" })),
      ...["2024-10-31", "2025-10-31", "2026-10-31"].map((date, i) => row(`yearly:${i}`, { transactionDate: date, description: "Fictional annual bill", category: "Subscriptions", amount: "100.00" })),
      ...["2026-10-21", "2026-10-28", "2026-11-04"].map((date, i) => row(`weekly:${i}`, { transactionDate: date, description: "Fictional weekly bill", category: "Utilities", amount: "8.00" })),
    ]);
  });

  it("keeps same-day payment order and the last N amounts rather than one amount per distinct date", () => {
    const transactions = [
      row("sept", { transactionDate: "2026-09-01", description: "Spotify", amount: "9.00" }),
      row("oct-first", { transactionDate: "2026-10-01", description: "Spotify", amount: "10.00" }),
      row("oct-second", { transactionDate: "2026-10-01", description: "Spotify", amount: "10.00" }),
      row("oct-third", { transactionDate: "2026-10-01", description: "Spotify", amount: "10" }),
      row("nov", { transactionDate: "2026-11-01", description: "Spotify", amount: "10.00" }),
    ];
    const facts = renewalParity(transactions);
    expect(facts[0].paymentCount).toBe(5); expect(facts[0].recentPayments).toHaveLength(4);
    expect(formatDisplayRenewals(facts, "2026-11-05", "GHS")[0]).toMatchObject({ expectedAmount: "10.00", variableAmount: false });
  });

  it("filters each fresh saved name before grouping id collisions", () => {
    const transactions = [
      row("water-custom-1", { transactionDate: "2026-09-01", description: "water", category: "Utilities" }),
      row("water-known-1", { transactionDate: "2026-10-01", description: "Ghana water", category: "Utilities" }),
      row("water-custom-2", { transactionDate: "2026-10-01", description: "water", category: "Utilities" }),
      row("water-known-2", { transactionDate: "2026-11-01", description: "Ghana water", category: "Utilities" }),
    ];
    for (const saved of [[], [bill("water")], [bill(" WATER BILL ")], [bill("water"), bill("Water bill")]]) renewalParity(transactions, saved);
    expect(renewalParity(transactions, [bill("water")])[0]).toMatchObject({ id: "water", name: "Water bill", paymentCount: 2 });
  });

  it("keeps future/deleted/zero/negative/other-currency sources out and expiry dependent on today", () => {
    const base = ["2026-09-01", "2026-10-01", "2026-11-01"].map((date, i) => row(`base:${i}`, { transactionDate: date, description: "Netflix" }));
    const ignored = [row("future", { transactionDate: "2026-12-01", description: "Netflix" }), row("deleted", { status: "deleted", description: "Netflix" }), row("zero", { amount: "0", description: "Netflix" }), row("negative", { amount: "-1", description: "Netflix" }), row("usd", { currency: "USD", description: "Netflix" })];
    expect(renewalParity([...base, ...ignored])[0].paymentCount).toBe(3);
    expect(formatDisplayRenewals(renewalParity(base), "2027-01-01", "GHS")).toEqual([]);
  });

  it("matches the existing renewal oracle across 256 seeded histories without unbounded evidence", () => {
    const descriptions = ["Netflix", "Ghana Water", "water", " Sample Rent ", " SAMPLE RENT ", "Spotify", "Fictional utility", "Unrelated expense"];
    for (let seed = 0; seed < 256; seed++) {
      const transactions = Array.from({ length: 96 }, (_, n) => row(`renewal:${seed}:${n}`, {
        transactionDate: addDays("2026-06-01", (n * 17 + seed * 7) % 200), description: descriptions[(n * 5 + seed) % descriptions.length],
        amount: ((n + seed) % 13 === 0 ? -10 : ((n + seed) % 4 === 0 ? 11 : 10)).toFixed(2),
        category: (n + seed) % 3 === 0 ? "Utilities" : "Subscriptions", status: (n + seed) % 17 === 0 ? "deleted" : "active", currency: (n + seed) % 19 === 0 ? "USD" : "GHS",
      })).reverse();
      renewalParity(transactions, seed % 3 === 0 ? [bill("water")] : seed % 3 === 1 ? [bill("Water bill")] : [], addDays("2026-11-01", seed % 16));
    }
  });
});
