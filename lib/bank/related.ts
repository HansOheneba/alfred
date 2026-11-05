import { sourceName } from "@/lib/bank/parse";
import type { BankMessage, BankStore } from "@/lib/bank/store";

/**
 * Some banks send several texts for one payment. An Absa transfer arrives as
 * "GHS 100.00 has been debited…" with no payee, "Transfer of GHS100 … to KOFI
 * MENSAH…" with the payee, and "GHS 1.00 has been debited…" for the fee, all
 * in the same minute. A card payment can also be put on hold ("earmarked")
 * and later show up again as a plain debit. These helpers find those links so
 * one payment is counted once.
 */

/** Texts this close together can be about the same payment. */
export const SAME_PAYMENT_MS = 3 * 60_000;
/** A small debit next to a bigger one is its fee when it's at most this, and at most a fifth of the payment. */
export const FEE_MAX = 10;
/** How long after a card hold the payment may go through. */
export const HOLD_DAYS = 10;

const minor = (amount: string) => Math.round(Number(amount) * 100);

/** A debit or credit that doesn't say who the money went to or came from. */
export function isBare(message: Pick<BankMessage, "counterparty" | "kind">): boolean {
  return !message.counterparty && (message.kind === "payment" || message.kind === "hold_settle");
}

/** Other texts from the same bank within a few minutes of `message`, the same way. */
export async function nearby(bank: BankStore, message: BankMessage): Promise<BankMessage[]> {
  const at = Date.parse(message.occurredAt);
  const around = await bank.listBetween(message.ownerId, new Date(at - SAME_PAYMENT_MS).toISOString(), new Date(at + SAME_PAYMENT_MS).toISOString());
  return around.filter((item) => item.id !== message.id && item.source === message.source && item.direction === message.direction);
}

/** Hubtel's "NAME has sent you GHS N" alert to the person receiving money through the Hubtel app. */
export function isHubtelSendNotice(message: Pick<BankMessage, "source" | "direction" | "raw">): boolean {
  return message.source === "hubtel" && message.direction === "in" && /has sent you GHS/i.test(message.raw);
}

/** A MoMo credit under the payment rail's name, which is how a Hubtel app payment reaches MoMo. */
export function isCreditInv(message: Pick<BankMessage, "source" | "direction" | "counterparty">): boolean {
  return message.source === "momo" && message.direction === "in" && /^credit[.\s_-]*inv\.?$/i.test(message.counterparty.trim());
}

/**
 * The other text about one Hubtel app payment: for a Hubtel "has sent you"
 * alert, the MoMo Credit.Inv credit of the same amount minutes apart, and the
 * other way round. Only an unambiguous single match counts.
 */
export async function hubtelSendTwin(bank: BankStore, message: BankMessage): Promise<BankMessage | null> {
  const notice = isHubtelSendNotice(message);
  if (!notice && !isCreditInv(message)) return null;
  const at = Date.parse(message.occurredAt);
  const around = await bank.listBetween(message.ownerId, new Date(at - SAME_PAYMENT_MS).toISOString(), new Date(at + SAME_PAYMENT_MS).toISOString());
  const twins = around.filter((item) => item.id !== message.id && item.status !== "skipped" && minor(item.amount) === minor(message.amount) && (notice ? isCreditInv(item) : isHubtelSendNotice(item)));
  return twins.length === 1 ? twins[0] : null;
}

/** The named text a bare one duplicates: same bank, same amount, minutes apart. */
export function namedTwin(message: BankMessage, around: BankMessage[]): BankMessage | null {
  return around.find((item) => item.counterparty && minor(item.amount) === minor(message.amount) && item.kind !== "hold_settle") ?? null;
}

/** The bare text a named one duplicates. */
export function bareTwin(message: BankMessage, around: BankMessage[]): BankMessage | null {
  return around.find((item) => isBare(item) && minor(item.amount) === minor(message.amount)) ?? null;
}

/** The payment a small bare debit is the fee for, if it is one. */
export function feeFor(message: BankMessage, around: BankMessage[]): BankMessage | null {
  const fee = minor(message.amount);
  if (message.direction !== "out" || !isBare(message) || fee > FEE_MAX * 100) return null;
  return around.find((item) => minor(item.amount) >= fee * 5) ?? null;
}

/** Small bare debits around a payment that are its fees, still waiting or excluded. */
export function feesAround(message: BankMessage, around: BankMessage[]): BankMessage[] {
  if (message.direction !== "out") return [];
  const amount = minor(message.amount);
  return around.filter(
    (item) =>
      isBare(item) &&
      !item.transactionId &&
      (item.status === "needs_label" || item.status === "skipped") &&
      minor(item.amount) <= FEE_MAX * 100 &&
      minor(item.amount) * 5 <= amount,
  );
}

/** "Absa fee · Kofi Mensah": what a fee is filed as. */
export function feeDescription(message: BankMessage, payment: BankMessage | null, titleCase: (value: string) => string): string {
  const bank = message.source === "other" ? "Bank" : sourceName(message.source);
  return `${bank} fee${payment?.counterparty ? ` · ${titleCase(payment.counterparty)}` : ""}`;
}

/**
 * A card payment still on hold that a bare debit may be: same bank, same
 * amount, held within the last few days, and not yet matched to a debit.
 */
export async function holdFor(bank: BankStore, message: BankMessage): Promise<BankMessage | null> {
  if (message.direction !== "out" || !isBare(message)) return null;
  const at = Date.parse(message.occurredAt);
  const earlier = await bank.listBetween(message.ownerId, new Date(at - HOLD_DAYS * 86_400_000).toISOString(), message.occurredAt);
  const holds = earlier.filter((item) => item.kind === "card_hold" && item.source === message.source && minor(item.amount) === minor(message.amount));
  return holds.at(-1) ?? null;
}
