import { describe, expect, it } from "vitest";

import { groundedPaymentLabel, paymentPurposeUnclear } from "@/lib/bank/reply";
import type { BankMessage } from "@/lib/bank/store";

// Fictional payee: the money went to one person, lent to another.
const payment = { id: "m1", ownerId: "o1", source: "momo", direction: "out", amount: "1000.00", fee: "0.00", currency: "GHS", counterparty: "AKOSUA MANSA BOATENG",
  raw: "Payment made for GHS 1000.00 to AKOSUA MANSA BOATENG", kind: "payment", status: "needs_label", occurredAt: "2026-11-03T15:19:00.000Z" } as unknown as BankMessage;

describe("answering a payment question with a loan", () => {
  it("reads 'a loan to Jesse' as lending, not also People spending", () => {
    expect(paymentPurposeUnclear("That was a loan to Jesse", "out")).toBe(false);
    expect(groundedPaymentLabel("That was a loan to Jesse", payment, { kind: "lent", person: "Jesse", note: null })).toBe(true);
  });

  it("still won't name someone the person didn't mention", () => {
    expect(groundedPaymentLabel("That was a loan to Jesse", payment, { kind: "lent", person: "Kwame", note: null })).toBe(false);
  });

  it("still asks when a real second purpose is named", () => {
    expect(paymentPurposeUnclear("a loan for food", "out")).toBe(true);
  });

  it("still reads a plain People answer as People", () => {
    expect(groundedPaymentLabel("People", payment, { kind: "category", category: "People" })).toBe(true);
  });
});
