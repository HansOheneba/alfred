import type { OwnTransferNotice } from "./own-transfers";
import { formatAmount, toMinor } from "@/lib/finance/money";

type Source = {
  id: string; ownerId: string; direction: "in" | "out"; amount: string; currency: string;
  kind: string; status: string; transactionId: string | null;
};

function accountLabel(value: string): string | null {
  const text = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return !text || text.length > 80 || /https?:\/\/|www\.|[<>\[\]`]/i.test(text) ? null : text;
}

/** Context comes from current owned source/account evidence, never URL or model text. */
export function transferMention(source: Source, transfer: OwnTransferNotice | null | undefined): { body: string; requiresPurpose: boolean; ledgerChanged: boolean } | null {
  if (!transfer || transfer.ownerId !== source.ownerId || transfer.currency !== source.currency ||
      transfer.fromAccount.id === transfer.toAccount.id || !transfer.fromAccount.id || !transfer.toAccount.id ||
      source.id !== (source.direction === "out" ? transfer.outgoingBankMessageId : transfer.incomingBankMessageId)) return null;
  let amount: string;
  try {
    if (toMinor(source.amount) <= 0 || toMinor(source.amount) !== toMinor(transfer.amount)) return null;
    amount = formatAmount(source.amount, source.currency);
  } catch { return null; }
  const from = accountLabel(transfer.fromAccount.label), to = accountLabel(transfer.toAccount.label);
  if (!from || !to) return null;
  const direction = source.direction === "in" ? "incoming" : "outgoing";
  if (transfer.state === "paired" && source.kind === "transfer_own" && source.status === "transfer") {
    return {
      body: `This ${direction} alert matches a ${amount} transfer from ${from} to ${to}. I've linked both sides, so the transfer isn't counted as income or spending.`,
      requiresPurpose: false, ledgerChanged: true,
    };
  }
  if (transfer.state === "candidate" && ["payment", "unknown"].includes(source.kind) && source.status === "needs_label" && !source.transactionId) {
    return {
      body: `This ${direction} alert for ${amount} could be a transfer from ${from} to ${to}. Was this money moving between your own accounts? You can tell me here.`,
      requiresPurpose: true, ledgerChanged: false,
    };
  }
  return null;
}
