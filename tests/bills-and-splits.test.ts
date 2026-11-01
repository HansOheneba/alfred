import { describe, expect, it } from "vitest";

import { applyLabel, ingestBankText, undoLabels, type IngestDeps } from "@/lib/bank/ingest";
import { MemoryBankStore } from "@/lib/bank/store";
import { accountTotals, buildSankeyModel, toLedgerRows, weeklyPace } from "@/lib/finance/analytics";
import { MemoryBillStore, detectRenewalCandidates, nextOccurrence, upcomingBills } from "@/lib/finance/bills";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { expense, profile } from "./helpers";

function setup() {
  const bank = new MemoryBankStore();
  const ledger = new MemoryFinanceStore();
  let sequence = 0;
  const deps: IngestDeps = {
    bank,
    ledger,
    now: new Date("2026-10-25T10:00:00.000Z"),
    createId: () => `7a1b2c3d-1111-4111-8111-${String(++sequence).padStart(12, "0")}`,
  };
  return { bank, ledger, deps, owner: profile(42) };
}

describe("included fee split, pass-through funds, and linked refunds", () => {
  it("splits an included fee out of an outgoing payment without changing total outflow, and undoes both rows", async () => {
    const { deps, ledger, owner } = setup();
    const sms =
      "Payment made for GHS 203.00 to KOFI MENSAH Current Balance: GHS 500.00 . Available Balance: GHS 500.00. Reference: Rent. Transaction ID: 90806990001. Fee charged: GHS0.00";
    const ingested = await ingestBankText(deps, owner, sms, { channel: "shortcut" });
    const messageId = ingested.outcomes[0]!.message.id;

    const labelled = await applyLabel(deps, owner, messageId, {
      kind: "category",
      category: "Rent & home",
      description: "Rent",
      includedFee: "3.00",
    });
    expect(labelled.ok).toBe(true);
    if (!labelled.ok) return;
    expect(labelled.text).toContain("GH₵200.00 under Rent & home + GH₵3.00 under Fees");

    const active = (await ledger.listTransactions("42")).filter((tx) => tx.status === "active");
    expect(active.map((tx) => [tx.category, tx.amount, tx.description])).toEqual([
      ["Rent & home", "200.00", "Rent"],
      ["Fees", "3.00", "Fees · Rent"],
    ]);

    await undoLabels(deps, owner, labelled.changes);
    expect((await ledger.listTransactions("42")).filter((tx) => tx.status === "active")).toHaveLength(0);
  });

  it("marks pass-through money handled for someone else without counting it as personal income or spending, while keeping explicit fees", async () => {
    const { deps, ledger, owner } = setup();
    const incoming =
      "Payment received for GHS 500.00 from AMA SERWAA Current Balance: GHS 900.00 . Available Balance: GHS 900.00. Reference: Vendor. Transaction ID: 90806990002. TRANSACTION FEE: 0.00";
    const outgoing =
      "Payment made for GHS 500.00 to YAW BOATENG Current Balance: GHS 398.50 . Available Balance: GHS 398.50. Reference: Vendor. Transaction ID: 90806990003. Fee charged: GHS1.50";
    const res = await ingestBankText(deps, owner, `${incoming}\n${outgoing}`, { channel: "shortcut" });

    const inReply = await applyLabel(deps, owner, res.outcomes[0]!.message.id, { kind: "pass_through", person: "Ama Serwaa" });
    const outReply = await applyLabel(deps, owner, res.outcomes[1]!.message.id, { kind: "pass_through", person: "Ama Serwaa" });
    expect(inReply.ok && outReply.ok).toBe(true);
    if (outReply.ok) expect(outReply.text).toContain("The GH₵1.50 fee still counts under Fees.");

    const active = (await ledger.listTransactions("42")).filter((tx) => tx.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ category: "Fees", amount: "1.50" });
  });

  it("files an incoming refund against the original spending category so it lowers spending instead of adding income", async () => {
    const { deps, ledger, owner } = setup();
    await ledger.appendTransaction(expense({ transactionDate: "2026-10-20", amount: "120.00", category: "Food", description: "Grocery order" }));
    const refundSms =
      "Payment received for GHS 35.00 from GLOVO GHANA Current Balance: GHS 435.00 . Available Balance: GHS 435.00. Reference: Refund. Transaction ID: 90806990004.";
    const ingested = await ingestBankText(deps, owner, refundSms, { channel: "shortcut" });
    const result = await applyLabel(deps, owner, ingested.outcomes[0]!.message.id, {
      kind: "refund",
      category: "Food",
      description: "Missing item",
    });
    expect(result.ok).toBe(true);
    const rows = toLedgerRows(await ledger.listTransactions("42"));
    const foodTotal = rows.filter((r) => r.category === "Food").reduce((sum, r) => sum + r.minor, 0);
    expect(foodTotal).toBe(8500);
  });
});

describe("bills, renewals, Sankey flow, account breakdown, and weekly pace", () => {
  it("computes next renewal dates across weekly, monthly, month-end, and yearly cadences", () => {
    expect(nextOccurrence({ active: true, nextDate: "2026-01-31", cadence: "monthly" }, "2026-02-10")).toBe("2026-02-28");
    expect(nextOccurrence({ active: true, nextDate: "2026-10-01", cadence: "weekly" }, "2026-10-16")).toBe("2026-10-22");
    expect(nextOccurrence({ active: false, nextDate: "2026-11-05", cadence: "monthly" }, "2026-10-25")).toBeNull();
  });

  it("detects recurring subscription candidates from transaction history and lists upcoming bills", async () => {
    const store = new MemoryBillStore();
    await store.save("42", { name: "Rent", nextDate: "2026-11-01", amount: "1500.00", currency: "GHS", cadence: "monthly" });
    const saved = await store.list("42");
    const due = upcomingBills(saved, "2026-10-25", 30);
    expect(due).toHaveLength(1);
    expect(due[0]?.renewalDate).toBe("2026-11-01");

    const history = [
      { ...expense({ transactionId: "s1", transactionDate: "2026-08-15", amount: "55.00", category: "Subscriptions", description: "Spotify" }), rowNumber: 1 },
      { ...expense({ transactionId: "s2", transactionDate: "2026-09-15", amount: "55.00", category: "Subscriptions", description: "Spotify" }), rowNumber: 2 },
      { ...expense({ transactionId: "s3", transactionDate: "2026-10-15", amount: "55.00", category: "Subscriptions", description: "Spotify" }), rowNumber: 3 },
    ];
    const suggestions = detectRenewalCandidates(history, saved, "2026-10-25", "GHS");
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      name: "Spotify",
      cadence: "monthly",
      expectedDate: "2026-11-15",
      expectedAmount: "55.00",
    });
  });

  it("builds Sankey flow, spending by account, and elapsed-week pace", () => {
    const rows = toLedgerRows([
      {
        ...expense({
          transactionId: "1",
          type: "income",
          transactionDate: "2026-10-20",
          amount: "1000.00",
          category: "Salary",
          description: "Pay",
          paymentMethod: "Absa",
        }),
        rowNumber: 1,
      },
      {
        ...expense({
          transactionId: "2",
          type: "expense",
          transactionDate: "2026-10-20",
          amount: "250.00",
          category: "Food",
          description: "Groceries",
          paymentMethod: "MoMo",
        }),
        rowNumber: 2,
      },
      {
        ...expense({
          transactionId: "3",
          type: "expense",
          transactionDate: "2026-10-13",
          amount: "200.00",
          category: "Transport",
          description: "Fuel",
          paymentMethod: "Absa",
        }),
        rowNumber: 3,
      },
    ]);

    const accounts = accountTotals(rows);
    expect(accounts).toEqual([
      { account: "MoMo", minor: 25000, count: 1 },
      { account: "Absa", minor: 20000, count: 1 },
    ]);

    const pace = weeklyPace(rows, "2026-10-21", "GHS");
    expect(pace).toMatchObject({
      thisWeekMinor: 25000,
      lastWeekSameStretchMinor: 20000,
      changePercent: 25,
    });

    const sankey = buildSankeyModel(
      rows.filter((r) => r.type === "income"),
      rows.filter((r) => r.type === "expense"),
    );
    expect(sankey).toMatchObject({
      incomingMinor: 100000,
      outgoingMinor: 45000,
      netMinor: 55000,
      remainderMinor: 55000,
      comparisonGapMinor: 0,
      massMinor: 100000,
    });
  });
});
