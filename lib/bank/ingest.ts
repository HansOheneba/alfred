import { isOwnName, parseBankText, payeeKey, type ParsedBankMessage } from "@/lib/bank/parse";
import { classifyPayee } from "@/lib/bank/payees";
import type { BankMessage, BankStore } from "@/lib/bank/store";
import type { UserProfile } from "@/lib/config";
import { normalizeCategory } from "@/lib/finance/categories";
import { addDays, zonedYmd } from "@/lib/finance/dates";
import { formatAmount } from "@/lib/finance/money";
import type { FinanceStore } from "@/lib/finance/store";

export type IngestDeps = {
  bank: BankStore;
  ledger: FinanceStore;
  now: Date;
  createId: () => string;
};

export type IngestOutcome = {
  message: BankMessage;
  outcome: "matched" | "recorded" | "needs_label" | "transfer" | "loan";
  category?: string;
  feeRecorded: boolean;
};

/** Choices offered when Alfred asks what a payment was, in button order. */
export const OUT_CHOICES = ["Food", "Transport", "People", "Personal", "Utilities", "Social", "Subscriptions", "Misc"] as const;
export const IN_CHOICES = ["Salary", "Business", "Gift", "Refund", "Other"] as const;

/** Card messages name no payee, so there's nothing to learn from them. */
function learnable(counterparty: string): boolean {
  // A channel like TELECEL PUSH reaches a different person each time, so filing it by name would be wrong.
  return Boolean(counterparty) && !/^gcb prepaid card/i.test(counterparty) && classifyPayee(counterparty).kind !== "channel";
}

export function titleCase(value: string): string {
  return value.toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function describe(message: Pick<BankMessage, "counterparty" | "direction" | "source">): string {
  if (!message.counterparty) return message.direction === "out" ? "Payment" : "Money received";
  const payee = classifyPayee(message.counterparty);
  if (payee.kind === "channel") return message.direction === "out" ? `Sent to ${payee.channel}` : `From ${payee.channel}`;
  if (payee.kind === "merchant" && payee.label) return payee.label;
  if (message.source === "gcb") return message.direction === "out" ? "GCB card payment" : "GCB card top-up";
  return message.direction === "out" ? `Payment to ${titleCase(message.counterparty)}` : `From ${titleCase(message.counterparty)}`;
}

function paymentMethod(message: Pick<BankMessage, "source">): string {
  return message.source === "gcb" ? "GCB card" : message.source === "momo" ? "MoMo" : "";
}

async function record(
  deps: IngestDeps,
  profile: UserProfile,
  message: BankMessage,
  input: { type: "income" | "expense"; amount: string; category: string; description: string; suffix?: string },
): Promise<string> {
  const id = deps.createId();
  const timestamp = deps.now.toISOString();
  await deps.ledger.appendTransaction({
    transactionId: id,
    createdAt: timestamp,
    transactionDate: zonedYmd(new Date(message.occurredAt), profile.timezone),
    userId: profile.profileId,
    type: input.type,
    amount: input.amount,
    currency: message.currency,
    category: input.category,
    description: input.description.slice(0, 200),
    paymentMethod: paymentMethod(message),
    notes: "",
    status: "active",
    updatedAt: timestamp,
    sourceUpdateId: `bank:${message.id}${input.suffix ?? ""}`,
  });
  return id;
}

/** A transaction the person already told Alfred about by hand, on the same or neighbouring day. */
async function findManualMatch(deps: IngestDeps, profile: UserProfile, message: BankMessage): Promise<string | null> {
  const day = zonedYmd(new Date(message.occurredAt), profile.timezone);
  const window = new Set([addDays(day, -1), day, addDays(day, 1)]);
  const linked = await deps.bank.linkedTransactionIds(profile.profileId);
  const type = message.direction === "out" ? "expense" : "income";
  const match = (await deps.ledger.listTransactions(profile.profileId)).find(
    (item) =>
      item.status === "active" &&
      item.type === type &&
      item.currency === message.currency &&
      Number(item.amount) === Number(message.amount) &&
      window.has(item.transactionDate) &&
      !item.sourceUpdateId.startsWith("bank:") &&
      !linked.has(item.transactionId),
  );
  return match?.transactionId ?? null;
}

function classify(parsed: ParsedBankMessage, names: string[]) {
  if (isOwnName(`${parsed.counterparty} ${parsed.reference}`, names)) return { kind: "transfer_own", status: "transfer" } as const;
  if (parsed.direction === "in" && /\bloan\b/i.test(parsed.counterparty)) return { kind: "loan_in", status: "loan" } as const;
  return { kind: "payment", status: "needs_label" } as const;
}

/**
 * Stores every money movement in `text` and decides what to do with each:
 * link it to something already logged, file it from a learned payee, treat it
 * as a transfer or loan, or hold it until the person says what it was.
 */
export async function ingestBankText(
  deps: IngestDeps,
  profile: UserProfile,
  text: string,
  options: { channel: BankMessage["channel"]; sender?: string | null; receivedAt?: Date },
): Promise<{ outcomes: IngestOutcome[]; duplicates: number; found: number }> {
  const parsed = parseBankText(text, { now: options.receivedAt ?? deps.now, timeZone: profile.timezone, sender: options.sender });
  const names = await deps.bank.accountNames(profile.profileId);
  const outcomes: IngestOutcome[] = [];
  let duplicates = 0;

  for (const item of parsed) {
    const { kind, status } = classify(item, names);
    const stored = await deps.bank.insertMessage({
      ownerId: profile.profileId,
      source: item.source,
      channel: options.channel,
      externalId: item.externalId,
      textHash: item.fingerprint,
      direction: item.direction,
      kind,
      amount: item.amount,
      fee: item.fee,
      currency: profile.currency,
      counterparty: item.counterparty,
      balance: item.balance,
      occurredAt: item.occurredAt,
      status,
      raw: item.raw,
    });
    if (!stored) {
      duplicates += 1;
      if (item.dated) await deps.bank.correctDate(profile.profileId, item.fingerprint, item.occurredAt);
      continue;
    }

    let feeRecorded = false;
    if (Number(stored.fee) > 0) {
      const feeId = await record(deps, profile, stored, {
        type: "expense",
        amount: stored.fee,
        category: "Fees",
        description: `${stored.source === "momo" ? "MoMo" : "Bank"} fee${stored.counterparty ? ` · ${titleCase(stored.counterparty)}` : ""}`,
        suffix: ":fee",
      });
      await deps.bank.updateMessage(profile.profileId, stored.id, { feeTransactionId: feeId });
      stored.feeTransactionId = feeId;
      feeRecorded = true;
    }

    if (status !== "needs_label") {
      outcomes.push({ message: stored, outcome: status, feeRecorded });
      continue;
    }

    const manual = await findManualMatch(deps, profile, stored);
    if (manual) {
      await deps.bank.updateMessage(profile.profileId, stored.id, { status: "matched", transactionId: manual });
      outcomes.push({ message: { ...stored, status: "matched", transactionId: manual }, outcome: "matched", feeRecorded });
      continue;
    }

    const rule = learnable(stored.counterparty) ? await deps.bank.getRule(profile.profileId, payeeKey(stored.counterparty)) : null;
    const type = stored.direction === "out" ? "expense" : "income";
    const category = rule ? normalizeCategory(rule.category, type) : null;
    if (rule && category) {
      const id = await record(deps, profile, stored, { type, amount: stored.amount, category, description: rule.description || describe(stored) });
      await deps.bank.updateMessage(profile.profileId, stored.id, { status: "recorded", transactionId: id });
      outcomes.push({ message: { ...stored, status: "recorded", transactionId: id }, outcome: "recorded", category, feeRecorded });
      continue;
    }

    // Well-known merchants (ECG, Bolt, DSTV…) don't need asking about.
    const payee = stored.direction === "out" ? classifyPayee(stored.counterparty) : null;
    if (payee?.kind === "merchant") {
      const description = payee.label || titleCase(stored.counterparty);
      const id = await record(deps, profile, stored, { type: "expense", amount: stored.amount, category: payee.category, description });
      await deps.bank.updateMessage(profile.profileId, stored.id, { status: "recorded", transactionId: id });
      outcomes.push({ message: { ...stored, status: "recorded", transactionId: id }, outcome: "recorded", category: payee.category, feeRecorded });
      continue;
    }

    outcomes.push({ message: stored, outcome: "needs_label", feeRecorded });
  }

  return { outcomes, duplicates, found: parsed.length };
}

export type Label =
  | { kind: "category"; category: string; description?: string | null }
  | { kind: "transfer" }
  | { kind: "skip" };

/** Files a held message once the person says what it was, and remembers the payee for next time. */
export async function applyLabel(
  deps: IngestDeps,
  profile: UserProfile,
  messageId: string,
  label: Label,
): Promise<{ ok: true; text: string } | { ok: false; text: string }> {
  const message = await deps.bank.getMessage(profile.profileId, messageId);
  if (!message) return { ok: false, text: "I couldn't find that payment anymore." };
  if (message.status !== "needs_label") return { ok: false, text: "That one is already sorted." };
  const money = formatAmount(message.amount, message.currency);

  if (label.kind === "skip") {
    await deps.bank.updateMessage(profile.profileId, message.id, { status: "skipped" });
    return { ok: true, text: `Left ${money} out of your books.` };
  }
  if (label.kind === "transfer") {
    await deps.bank.updateMessage(profile.profileId, message.id, { status: "transfer", kind: "transfer_own" });
    return { ok: true, text: `Noted. ${money} was your own money moving between accounts, so it isn't counted as income or spending.` };
  }

  const type = message.direction === "out" ? "expense" : "income";
  const category = normalizeCategory(label.category, type);
  if (!category) return { ok: false, text: "That category doesn't fit. Pick one from the list." };
  const description = label.description?.trim() || describe(message);
  const id = await record(deps, profile, message, { type, amount: message.amount, category, description });
  await deps.bank.updateMessage(profile.profileId, message.id, { status: "recorded", transactionId: id });
  const remembers = learnable(message.counterparty);
  if (remembers) {
    await deps.bank.saveRule(profile.profileId, {
      payeeKey: payeeKey(message.counterparty),
      category,
      description: label.description?.trim() ? description : "",
    });
  }
  const who = titleCase(message.counterparty);
  return {
    ok: true,
    text: remembers
      ? `Filed ${money} under ${category}. I'll file ${who} as ${category} from now on.`
      : `Filed ${money} under ${category}.`,
  };
}

/** The question Alfred asks about a held payment. */
export function labelQuestion(message: BankMessage, timeZone: string): string {
  const money = formatAmount(message.amount, message.currency);
  const when = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone }).format(
    new Date(message.occurredAt),
  );
  const payee = classifyPayee(message.counterparty);
  if (payee.kind === "channel") {
    const network = titleCase(message.counterparty);
    return message.direction === "out"
      ? `${money} sent from MoMo to ${payee.channel} (${network}) · ${when}. These transfers don't say who received the money. Who was it to, and what for?`
      : `${money} came in from ${payee.channel} (${network}) · ${when}. Who sent it, and what was it?`;
  }
  if (message.direction === "out") {
    const to = message.counterparty && !/^gcb/i.test(message.counterparty) ? ` to ${titleCase(message.counterparty)}` : " on your GCB card";
    return `${money}${to} · ${when}. What was that for?`;
  }
  const from = message.counterparty && !/^gcb/i.test(message.counterparty) ? ` from ${titleCase(message.counterparty)}` : " onto your GCB card";
  return `${money} came in${from} · ${when}. What was it?`;
}
