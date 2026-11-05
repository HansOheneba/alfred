import { describe, expect, it } from "vitest";
import { prepareTransactionEdit } from "@/app/dashboard/transaction-edit-review";
import type { LedgerRow } from "@/lib/finance/analytics";

const row: LedgerRow = { id: "sample", type: "expense", amount: "1500.00", minor: 150000, currency: "GHS", category: "Investments", date: "2026-11-01", description: "Sample payment", paymentMethod: "Cash" };
const draft = { type: row.type, amount: row.amount, category: row.category, date: row.date, description: row.description, includedFee: "" };

describe("explicit manual transaction review", () => {
  it("reviews a category correction against the exact original without adding another expense", () => {
    const result = prepareTransactionEdit(row, { ...draft, category: "Rent & home" });
    expect(result).toEqual({ ok: true, review: { changes: { category: "Rent & home" }, differences: [{ label: "Category", before: "Investments", after: "Rent & home" }], splitsFee: false } });
    expect(row.category).toBe("Investments"); expect(row.minor).toBe(150000);
  });
  it("reviews principal and fee separately while retaining the combined amount", () => {
    const result = prepareTransactionEdit(row, { ...draft, amount: "1600", includedFee: "15" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.review.changes).toEqual({ amount: "1600.00", includedFee: "15.00" });
    expect(result.review.differences).toEqual([{ label: "Payment amount", before: "GH₵1,500.00", after: "GH₵1,585.00" }, { label: "Separate fee", before: "None", after: "GH₵15.00" }]);
  });
  it.each([{ amount: "0" }, { includedFee: "1500" }, { date: "2026-02-31" }, { description: " " }])("rejects invalid review data %j", change => {
    expect(prepareTransactionEdit(row, { ...draft, ...change }).ok).toBe(false);
  });
  it("does not stage a redundant save for unchanged values", () => {
    const result = prepareTransactionEdit(row, draft);
    expect(result.ok && result.review.changes).toEqual({});
  });
});
