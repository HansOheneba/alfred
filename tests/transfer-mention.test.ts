import { describe, expect, it } from "vitest";
import { transferMention } from "@/lib/bank/transfer-mention";
import type { OwnTransferNotice } from "@/lib/bank/own-transfers";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const outgoing = "11111111-1111-4111-8111-111111111111", incoming = "22222222-2222-4222-8222-222222222222";
const source = { id: outgoing, ownerId: owner, direction: "out" as const, amount: "1.00", currency: "GHS", kind: "transfer_own", status: "transfer", transactionId: null };
const pair: OwnTransferNotice = { state: "paired", ownerId: owner, pairId: "synthetic-pair", evidenceFingerprint: "synthetic-evidence", outgoingBankMessageId: outgoing, incomingBankMessageId: incoming,
  amount: "1.00", currency: "GHS", fromAccount: { id: "hubtel", label: "Holiday wallet" }, toAccount: { id: "momo", label: "Everyday MoMo" } };

describe("transfer conversation wording", () => {
  it("acknowledges the saved named pair in either direction without a modal or purpose question", () => {
    for (const row of [source, { ...source, id: incoming, direction: "in" as const }]) {
      const mention = transferMention(row, pair)!;
      expect(mention.body).toContain("GH₵1.00 transfer from Holiday wallet to Everyday MoMo");
      expect(mention.body).toContain("isn't counted as income or spending");
      expect(mention.body).not.toMatch(/review|modal|what was|settled|bank confirmed/i);
      expect(mention.requiresPurpose).toBe(false); expect(mention.ledgerChanged).toBe(true);
    }
  });
  it("asks in chat about an unlabelled candidate without claiming it has been paired", () => {
    const mention = transferMention({ ...source, kind: "payment", status: "needs_label" }, { ...pair, state: "candidate" })!;
    expect(mention.body).toContain("could be a transfer"); expect(mention.body).toContain("Was this money moving between your own accounts?");
    expect(mention.body).not.toContain("I've linked"); expect(mention.requiresPurpose).toBe(true); expect(mention.ledgerChanged).toBe(false);
  });
  it("does not overwrite a later label or trust mismatched owner, source, account, currency or principal", () => {
    for (const patch of [{ ownerId: "foreign" }, { currency: "USD" }, { amount: "0.50" }, { outgoingBankMessageId: incoming }, { fromAccount: pair.toAccount }]) {
      expect(transferMention(source, { ...pair, ...patch })).toBeNull();
    }
    expect(transferMention({ ...source, status: "recorded", kind: "payment", transactionId: "saved" }, { ...pair, state: "candidate" })).toBeNull();
    expect(transferMention({ ...source, status: "needs_label", kind: "payment" }, pair)).toBeNull();
  });
  it.each(["https://evil.invalid", "<b>Wallet</b>", "x".repeat(81), ""])("excludes unsafe or invalid account labels: %s", label => {
    expect(transferMention(source, { ...pair, fromAccount: { ...pair.fromAccount, label } })).toBeNull();
  });
});
