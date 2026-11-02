import { describe, expect, it } from "vitest";
import { applyAccountingAction } from "@/lib/finance/accounting/reducer";
import { buildAccountingView } from "@/lib/finance/accounting/view";
import { buildPreviewLedger, previewBalanceAccounts } from "@/ui-preview/accounting-ledger";
import { previewAccountingFixture as initial, PREVIEW_ACCOUNTING_NOW } from "@/ui-preview/accounting-fixture";
import { previewOccurrenceFor } from "@/ui-preview/transaction-times";

describe("shared synthetic finance screens", () => {
  it("keeps the annotated monthly totals and source timestamps consistent", () => {
    const ledger = buildPreviewLedger(initial);
    const month = ledger.rows.filter((row) => row.date.startsWith("2026-10"));
    expect(month.filter((row) => row.type === "expense").reduce((sum, row) => sum + row.minor, 0)).toBe(550785);
    expect(month.filter((row) => row.type === "income").reduce((sum, row) => sum + row.minor, 0)).toBe(1105000);
    expect(month.every((row) => previewOccurrenceFor(row) !== null)).toBe(true);
    expect(buildAccountingView(initial, "GHS").balances).toMatchObject({ count: 2, totalMinor: 1431815, missingCount: 0 });
  });
  it("propagates inclusion and unknown balance state instead of inferring cash from activity", () => {
    const changed = applyAccountingAction(initial, { type: "update_account", accountId: "demo-account-momo", changes: { includeInCash: false }, expectedRevision: 0, requestId: "exclude-demo" }, PREVIEW_ACCOUNTING_NOW);
    expect(buildAccountingView(changed, "GHS").balances).toMatchObject({ count: 1, totalMinor: 1248575 });
    expect(previewBalanceAccounts(changed).find((account) => account.id === "demo-account-momo")?.included).toBe(false);
    expect(buildPreviewLedger(changed).rows).toEqual(buildPreviewLedger(initial).rows);
    const unknown = applyAccountingAction(initial, { type: "create_account", account: { id: "cash", label: "Cash", provider: "Manual", currency: "GHS", includeInCash: true }, expectedRevision: 0, requestId: "unknown-demo" }, PREVIEW_ACCOUNTING_NOW);
    expect(buildAccountingView(unknown, "GHS").balances).toMatchObject({ count: 3, totalMinor: null, missingCount: 1, knownSubtotalMinor: 1431815 });
  });
  it("recomputes category budgets and insights from the same classification", () => {
    const source = initial.movements.find((movement) => movement.id === "demo-oct-food-11")!;
    const changed = applyAccountingAction(initial, { type: "classify_movement", movement: { movementId: source.id, sourceFingerprint: source.sourceFingerprint }, status: "confirmed", category: "Pet care", expectedRevision: 0, requestId: "category-demo" }, PREVIEW_ACCOUNTING_NOW);
    const before = buildPreviewLedger(initial), after = buildPreviewLedger(changed);
    expect(after.rows.find((row) => row.id === `accounting:${source.id}`)?.category).toBe("Pet care");
    expect(after.budgets.find((budget) => budget.category === "Food")!.spentMinor).toBe(before.budgets.find((budget) => budget.category === "Food")!.spentMinor - source.amountMinor);
    expect(after.insights[1]).not.toEqual(before.insights[1]);
  });
  it("restates an original refund month while leaving balances and source records unchanged", () => {
    const original = initial.movements.find((movement) => movement.id === "demo-refund-original")!;
    const returned = initial.movements.find((movement) => movement.id === "demo-refund-return")!;
    const changed = applyAccountingAction(initial, { type: "save_settlement", settlement: { id: "refund", kind: "refund", original: { movementId: original.id, sourceFingerprint: original.sourceFingerprint }, returns: [{ movementId: returned.id, sourceFingerprint: returned.sourceFingerprint, principalMinor: 12000 }] }, expectedRevision: 0, requestId: "refund-demo" }, PREVIEW_ACCOUNTING_NOW);
    const ledger = buildPreviewLedger(changed);
    expect(ledger.rows.find((row) => row.id === `accounting:${original.id}`)).toMatchObject({ date: original.date, minor: 28000 });
    expect(ledger.rows.some((row) => row.id === `accounting:${returned.id}`)).toBe(false);
    expect(changed.movements).toEqual(initial.movements);
    expect(previewBalanceAccounts(changed)).toEqual(previewBalanceAccounts(initial));
  });
});
