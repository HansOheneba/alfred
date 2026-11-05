import { describe, expect, it } from "vitest";

import { applyAccountRules, namedAccount } from "@/lib/account-rules/matcher";
import { accountBalanceFacts } from "@/lib/finance/accounting/accounts";
import { sourceMovements } from "@/lib/finance/accounting/sources";
import { emptyAccountingState, type AccountingState, type FinancialAccount } from "@/lib/finance/accounting/types";
import type { TransactionRecord } from "@/lib/finance/types";

const OWNER = "00000000-0000-4000-8000-000000000042";
const account = (id: string, label: string, provider: string): FinancialAccount => ({ id, label, provider, currency: "GHS", includeInCash: true, createdAt: "2026-11-01T00:00:00.000Z" });
const HUBTEL = account("acct-hubtel", "Hubtel wallet", "Hubtel");
const MOMO = account("acct-momo", "MTN MoMo", "MTN Mobile Money");

function entry(id: string, over: Partial<TransactionRecord> = {}): TransactionRecord {
  return { transactionId: id, createdAt: "2026-11-05T21:00:00.000Z", transactionDate: "2026-11-05", userId: OWNER, type: "expense", amount: "80.00", currency: "GHS",
    category: "People", description: "Gift", paymentMethod: "Hubtel wallet", notes: "", status: "active", updatedAt: "2026-11-05T21:00:00.000Z", sourceUpdateId: `chat:${id}`, rowNumber: 0, ...over };
}

/** Accounts with one reported Hubtel balance, then the entries as the read path binds them. */
function state(entries: TransactionRecord[], reportedAt = "2026-11-05T09:00:00.000Z"): AccountingState {
  const base: AccountingState = { ...emptyAccountingState(OWNER), accounts: [HUBTEL, MOMO],
    snapshots: [{ id: "snap-1", accountId: HUBTEL.id, balanceMinor: 50_000, occurredAt: reportedAt, sourceId: "manual-1", sourceMovementId: null }] };
  return applyAccountRules({ ...base, movements: sourceMovements(OWNER, entries, []) }, { ownerId: OWNER, revision: 0, rules: [], bindings: [] });
}
const hubtelRow = (value: AccountingState) => accountBalanceFacts(value).find((row) => row.account.id === HUBTEL.id)!;

describe("chat entries that name an account", () => {
  it("ties the entry to the one account that answers to the name", () => {
    expect(namedAccount({ sourceLabel: "Hubtel wallet", currency: "GHS" }, { accounts: [HUBTEL, MOMO] })).toBe(HUBTEL.id);
    expect(namedAccount({ sourceLabel: "momo", currency: "GHS" }, { accounts: [HUBTEL, MOMO] })).toBe(MOMO.id);
  });

  it("leaves it unassigned when no account or several match, or none was named", () => {
    expect(namedAccount({ sourceLabel: "Absa", currency: "GHS" }, { accounts: [HUBTEL, MOMO] })).toBeNull();
    expect(namedAccount({ sourceLabel: "Hubtel", currency: "GHS" }, { accounts: [HUBTEL, account("acct-2", "Hubtel savings", "Hubtel")] })).toBeNull();
    expect(namedAccount({ sourceLabel: "Manual / cash", currency: "GHS" }, { accounts: [HUBTEL, MOMO] })).toBeNull();
  });

  it("takes an entry logged after the last report off that account's balance", () => {
    const row = hubtelRow(state([entry("t1")]));
    expect(row.reported?.balanceMinor).toBe(50_000);
    expect(row.loggedSinceMinor).toBe(-8_000);
    expect(row.snapshot?.balanceMinor).toBe(42_000);
  });

  it("adds money logged as coming in", () => {
    expect(hubtelRow(state([entry("t1", { type: "income", amount: "25.00" })])).snapshot?.balanceMinor).toBe(52_500);
  });

  it("doesn't count an entry the next bank report already includes", () => {
    expect(hubtelRow(state([entry("t1")], "2026-11-05T22:00:00.000Z")).snapshot?.balanceMinor).toBe(50_000);
  });

  it("doesn't count an entry dated before the report, even if logged after it", () => {
    expect(hubtelRow(state([entry("t1", { transactionDate: "2026-11-04" })])).snapshot?.balanceMinor).toBe(50_000);
  });

  it("ignores deleted entries and entries for other accounts", () => {
    const row = hubtelRow(state([entry("t1", { status: "deleted" }), entry("t2", { paymentMethod: "MoMo" })]));
    expect(row.loggedSinceMinor).toBe(0);
    expect(row.snapshot?.balanceMinor).toBe(50_000);
  });
});
