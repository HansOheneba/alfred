import { payeeKey } from "@/lib/bank/parse";
import { waitingLine } from "@/lib/bank/reply";
import type { BankMessage, BankStore } from "@/lib/bank/store";
import type { UserProfile } from "@/lib/config";
import type { LoanStore } from "@/lib/finance/loans";
import { toMinor } from "@/lib/finance/money";
import type { FinanceStore } from "@/lib/finance/store";

/** How many earlier answers Alfred shows the model for one payment. */
const SHOWN = 3;

/**
 * How the person filed payments like this one before, in plain lines: the
 * same payee, or for a nameless card charge, the same card and a similar
 * amount. This is how Alfred learns from them without being told twice:
 * "same as last month" or a second Claude charge reads like the first.
 * Only this person's filed payments are read.
 */
export async function rememberedAnswers(deps: { bank: BankStore; store: FinanceStore; loans?: LoanStore | null }, profile: UserProfile, current: BankMessage): Promise<string[]> {
  const owner = profile.profileId;
  const filed = (await deps.bank.listMessages(owner))
    .filter((message) => message.ownerId === owner && message.id !== current.id && message.status !== "needs_label")
    .map((message) => ({ message, score: likeness(message, current) }))
    .filter((item) => item.score >= 2)
    .sort((left, right) => right.score - left.score || right.message.occurredAt.localeCompare(left.message.occurredAt))
    .slice(0, SHOWN);
  if (filed.length === 0) return [];
  const [transactions, loans] = await Promise.all([deps.store.listTransactions(owner), deps.loans?.list(owner) ?? []]);
  const byId = new Map(transactions.filter((row) => row.userId === owner).map((row) => [row.transactionId, row]));
  return filed.map(({ message }) => {
    const row = message.transactionId ? byId.get(message.transactionId) : undefined;
    const person = loans.find((entry) => entry.bankMessageId === message.id)?.person;
    return `${waitingLine(message, profile)} → ${filedAs(message, row?.category, row?.description, person)}`;
  });
}

/** 3 for the same named payee; for nameless charges, 2 for the same source, direction and a similar amount. */
function likeness(left: BankMessage, right: BankMessage): number {
  if (left.direction !== right.direction) return 0;
  const named = payeeKey(left.counterparty);
  if (named && named === payeeKey(right.counterparty) && !/^gcb prepaid card/.test(named)) return 3;
  const a = toMinor(left.amount), b = toMinor(right.amount);
  const similar = Math.abs(a - b) <= Math.max(a, b) * 0.2;
  return left.source === right.source && similar && (!left.counterparty.trim() || !right.counterparty.trim() || named === payeeKey(right.counterparty)) ? 2 : 0;
}

function filedAs(message: BankMessage, category: string | undefined, description: string | undefined, person: string | undefined): string {
  switch (message.status) {
    case "recorded": case "matched": return category ? `${category}${description ? ` (${description})` : ""}` : "recorded";
    case "transfer": return "own_transfer: their own money moving between accounts";
    case "lent": return `lent${person ? ` to ${person}` : ""}`;
    case "borrowed": return `borrowed${person ? ` from ${person}` : ""}`;
    case "repaid": return `repaid${person ? ` by ${person}` : ""}`;
    case "paid_back": return `paid back${person ? ` to ${person}` : ""}`;
    case "invested": return "invested";
    case "skipped": return "left out (handled for someone else, or not a payment)";
    default: return message.status;
  }
}
