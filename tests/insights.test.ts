import { describe, expect, it, vi } from "vitest";

import { keepsFacts, voiceDelivery } from "@/lib/ai/voice";
import { buildInsights } from "@/lib/finance/insights";
import type { TransactionRecord } from "@/lib/finance/types";
import { expense, profile } from "./helpers";

let row = 0;
function spend(date: string, amount: string, category: string, description: string): TransactionRecord {
  row += 1;
  return { ...expense({ transactionDate: date, amount, category, description }), transactionId: `id-${row}`, rowNumber: row };
}

describe("insights", () => {
  const transactions = [
    spend("2026-09-03", "100.00", "Food", "Groceries"),
    spend("2026-09-05", "40.00", "Transport", "Uber"),
    spend("2026-10-02", "30.00", "Transport", "Uber"),
    spend("2026-10-03", "30.00", "Transport", "Uber"),
    spend("2026-10-04", "30.00", "Transport", "Uber"),
    spend("2026-10-05", "200.00", "Personal", "Shoes"),
    spend("2026-10-06", "60.00", "Food", "Groceries"),
  ];
  const lines = buildInsights({
    userId: "42",
    currency: "GHS",
    range: { start: "2026-10-01", end: "2026-10-31" },
    today: "2026-10-10",
    transactions,
    budgets: [
      { budgetId: "b1", userId: "42", period: "2026-10", category: "Transport", amount: "100.00", currency: "GHS", createdAt: "", updatedAt: "", rowNumber: 1 },
    ],
  });

  it("names the biggest categories with their share", () => {
    expect(lines).toContain("Where the money went: Personal GH₵200.00 (57%), Transport GH₵90.00 (26%), Food GH₵60.00 (17%).");
  });

  it("spots repeated spending and the biggest expense", () => {
    expect(lines).toContain("Repeated spend: Uber 3 times, GH₵90.00 in total.");
    expect(lines).toContain("Biggest single expense: Shoes, GH₵200.00 (Personal).");
  });

  it("compares a month in progress with the same days of last month", () => {
    expect(lines).toContain("Up GH₵210.00 on the same stretch of the previous period (GH₵140.00).");
  });

  it("flags a budget that is nearly used", () => {
    expect(lines).toContain("Transport budget has GH₵10.00 left (90% used).");
  });
});

describe("voice", () => {
  it("accepts a reply that only repeats known figures and the dashboard link", () => {
    expect(keepsFacts("Lovely work. GH₵90.00 on Uber, see alfred.hansopoku.com", "Uber 3 times, GH₵90.00")).toBe(true);
  });

  it("rejects a reply with a new figure or another link", () => {
    expect(keepsFacts("You spent GH₵95.00 on Uber", "Uber GH₵90.00")).toBe(false);
    expect(keepsFacts("Try budget.example.com", "Uber GH₵90.00")).toBe(false);
  });

  it("falls back to the server text when the voice invents a number", async () => {
    const voice = vi.fn(async () => "You've spent GH₵999.00 this month.");
    const delivery = await voiceDelivery(
      voice,
      { type: "get_spending_summary" },
      { kind: "text", text: "You've spent GH₵45.00 this month." },
      { userText: "how much this month", profile: profile(), channel: "telegram" },
    );
    expect(delivery.text).toBe("You've spent GH₵45.00 this month.");
  });

  it("leaves confirmations alone", async () => {
    const voice = vi.fn(async () => "reworded");
    const delivery = await voiceDelivery(
      voice,
      { type: "delete_transaction", undo_last: false },
      { kind: "confirm", text: "Delete this transaction?", actionId: "a1" },
      { userText: "delete lunch", profile: profile(), channel: "telegram" },
    );
    expect(delivery.text).toBe("Delete this transaction?");
    expect(voice).not.toHaveBeenCalled();
  });
});
