import { accountOf, isOwnName, parseBankText, payeeKey, purposeOf, sourceName, withoutRecipient, type ParsedBankMessage } from "@/lib/bank/parse";
import { classifyPayee } from "@/lib/bank/payees";
import { looksLikeMoney, type UnknownTextReader } from "@/lib/bank/read-unknown";
import { findInvestment, type Investment, type InvestmentStore } from "@/lib/investments/store";
import { bareTwin, feeDescription, feeFor, feesAround, holdFor, isBare, namedTwin, nearby } from "@/lib/bank/related";
import type { BankMessage, BankStore, LabelChange } from "@/lib/bank/store";
import type { UserProfile } from "@/lib/config";
import type { BankAccess } from "@/lib/finance/action-router";
import { normalizeCategory } from "@/lib/finance/categories";
import { addDays, formatDisplayDate, zonedYmd } from "@/lib/finance/dates";
import type { NotebookStore } from "@/lib/notebook/store";
import type { PeopleStore } from "@/lib/people/store";
import { findPerson, owedBy, oweTo, personKey, type LoanStore } from "@/lib/finance/loans";
import { canonicalizeAmount, formatAmount, toMinor } from "@/lib/finance/money";
import type { FinanceStore } from "@/lib/finance/store";

export type IngestDeps = {
  bank: BankStore;
  ledger: FinanceStore;
  now: Date;
  createId: () => string;
  /** Money lent out. Without it, lending labels aren't offered. */
  loans?: LoanStore;
  /** What the person told Alfred about people, mentioned when asking about their payments. */
  people?: PeopleStore | null;
  /** Reads texts from banks Alfred has no rules for. Without it, those texts are left out. */
  readUnknown?: UnknownTextReader | null;
  /** Where money into investments is tracked. Without it, the Investment label isn't offered. */
  investments?: InvestmentStore | null;
};

export type IngestOutcome = {
  message: BankMessage;
  outcome: "matched" | "recorded" | "needs_label" | "transfer" | "loan" | "skipped" | "invested";
  /** The category it was filed under, or for money into an investment, the investment's name. */
  category?: string;
  /** Filed as someone's share of a bill, lowering `category`'s spending. */
  chipIn?: boolean;
  feeRecorded: boolean;
};

/** Choices offered when Alfred asks what a payment was, in button order. */
export const OUT_CHOICES = ["Food", "Transport", "People", "Personal", "Utilities", "Social", "Subscriptions", "Misc"] as const;
export const IN_CHOICES = ["Salary", "Business", "Gift", "Refund", "Other"] as const;

/** Card checks and test sends: this much or less is left out without asking. */
export const TINY_AMOUNT = 1;

/** Card messages name no payee, so there's nothing to learn from them. */
export function learnable(counterparty: string): boolean {
  // A channel like TELECEL PUSH reaches a different person each time, so filing it by name would be wrong.
  return Boolean(counterparty) && !/^gcb prepaid card/i.test(counterparty) && classifyPayee(counterparty).kind !== "channel";
}

/**
 * True when a sender shares the person's first name, e.g. HANS OHENEBA… for Hans.
 * Used only to ask the right question; it never files anything on its own.
 */
export function looksLikeOwner(counterparty: string, preferredName: string): boolean {
  const first = preferredName.trim().split(/\s+/)[0]?.toLowerCase();
  return Boolean(first && first.length > 1 && counterparty.trim().toLowerCase().split(/\s+/)[0] === first);
}

/** How many of a bank's texts, read by the model, the person must confirm before Alfred files that bank's payments on its own. */
export const TRUSTED_AFTER = 3;

/** Statuses that mean the person settled a payment themselves, confirming Alfred read it right. */
const CONFIRMED = new Set(["recorded", "matched", "transfer", "lent", "repaid", "borrowed", "paid_back"]);

/** True once enough of a bank's model-read texts have been confirmed by the person. */
async function trustsReading(bank: BankStore, ownerId: string, source: string): Promise<boolean> {
  const confirmed = (await bank.listMessages(ownerId)).filter((item) => item.source === source && item.readBy === "model" && CONFIRMED.has(item.status));
  return confirmed.length >= TRUSTED_AFTER;
}

/** Labels too vague to teach Alfred anything about a payee. */
const VAGUE = new Set(["Other", "Misc"]);

export function titleCase(value: string): string {
  return value.toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function describe(message: Pick<BankMessage, "counterparty" | "direction" | "source">): string {
  if (!message.counterparty) return message.direction === "out" ? "Payment" : "Money received";
  const payee = classifyPayee(message.counterparty);
  if (payee.kind === "channel") return message.direction === "out" ? `Sent to ${payee.channel}` : `From ${payee.channel}`;
  if (payee.kind === "merchant" && payee.label) return payee.label;
  if (message.source === "gcb") return message.direction === "out" ? "GCB card payment" : "GCB card top-up";
  if (!message.counterparty) return message.direction === "out" ? `${sourceName(message.source)} payment` : `Into ${sourceName(message.source)}`;
  return message.direction === "out" ? `Payment to ${titleCase(message.counterparty)}` : `From ${titleCase(message.counterparty)}`;
}

function paymentMethod(message: Pick<BankMessage, "source">): string {
  return message.source === "other" ? "" : sourceName(message.source);
}

async function record(
  deps: IngestDeps,
  profile: UserProfile,
  message: BankMessage,
  input: { type: "income" | "expense"; amount: string; category: string; description: string; suffix?: string; date?: string },
): Promise<string> {
  const id = deps.createId();
  const timestamp = deps.now.toISOString();
  await deps.ledger.appendTransaction({
    transactionId: id,
    createdAt: timestamp,
    transactionDate: input.date ?? zonedYmd(new Date(message.occurredAt), profile.timezone),
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
  if (isOwnName(`${parsed.counterparty} ${withoutRecipient(parsed.reference)}`, names)) return { kind: "transfer_own", status: "transfer" } as const;
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
  const now = options.receivedAt ?? deps.now;
  // Texts from MoMo, GCB and Hubtel that the rules skipped are notices, not payments.
  const knownSender = /gcb|hubtel|momo|mobile ?money|\bmtn\b/i.test(options.sender ?? "");
  // Forwarded texts can be from anyone, so outside MoMo and GCB the model decides what's a payment, not
  // the loose "GHS plus a money word" rule, which would take "I've sent you GHS 50" from a friend.
  const modelReads = Boolean(deps.readUnknown) && !knownSender && options.channel !== "screenshot";
  let parsed = parseBankText(text, { now, timeZone: profile.timezone, sender: options.sender, loose: !modelReads });
  let readBy: BankMessage["readBy"] = "rules";
  // A bank Alfred has no rules for: the model reads it, and the server checks its figures against the text.
  if (parsed.length === 0 && deps.readUnknown && modelReads && looksLikeMoney(text)) {
    parsed = await deps.readUnknown(text, { sender: options.sender ?? null, now });
    readBy = "model";
  }
  const names = await deps.bank.accountNames(profile.profileId);
  const ignored = await deps.bank.ignoredAccounts(profile.profileId);
  const outcomes: IngestOutcome[] = [];
  let duplicates = 0;

  for (const item of parsed) {
    // Texts from an account that isn't the person's money, like a parent's they manage, are left out entirely.
    const account = accountOf(item.raw);
    if (account && ignored.includes(account)) continue;
    const { kind, status } = classify(item, names);
    const stored = await deps.bank.insertMessage({
      ownerId: profile.profileId,
      source: item.source,
      channel: options.channel,
      externalId: item.externalId,
      textHash: item.fingerprint,
      direction: item.direction,
      kind: kind === "payment" && item.hold ? "card_hold" : kind,
      amount: item.amount,
      fee: item.fee,
      currency: profile.currency,
      counterparty: item.counterparty,
      balance: item.balance,
      occurredAt: item.occurredAt,
      status,
      raw: item.raw,
      readBy,
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
        description: `${stored.source === "other" ? "Bank" : sourceName(stored.source)} fee${stored.counterparty ? ` · ${titleCase(stored.counterparty)}` : ""}`,
        suffix: ":fee",
      });
      await deps.bank.updateMessage(profile.profileId, stored.id, { feeTransactionId: feeId });
      stored.feeTransactionId = feeId;
      feeRecorded = true;
    }

    // Several texts can be one payment, like Absa's debit, transfer and fee: link them so it's counted once.
    const linked = await linkRelated(deps, profile, stored);
    if (linked) {
      outcomes.push({ ...linked, feeRecorded });
      continue;
    }

    if (status !== "needs_label") {
      outcomes.push({ message: stored, outcome: status, feeRecorded });
      continue;
    }

    // A debit that may be a card payment already counted while on hold is asked about before it counts.
    if (stored.kind === "hold_settle") {
      outcomes.push({ message: stored, outcome: "needs_label", feeRecorded });
      continue;
    }

    // While Alfred is still learning a bank's texts, the person confirms each payment, so a misreading can't slip in.
    if (stored.readBy === "model" && !(await trustsReading(deps.bank, profile.profileId, stored.source))) {
      outcomes.push({ message: stored, outcome: "needs_label", feeRecorded });
      continue;
    }

    if (Number(stored.amount) <= TINY_AMOUNT) {
      await deps.bank.updateMessage(profile.profileId, stored.id, { status: "skipped" });
      outcomes.push({ message: { ...stored, status: "skipped" }, outcome: "skipped", feeRecorded });
      continue;
    }

    const manual = await findManualMatch(deps, profile, stored);
    if (manual) {
      await deps.bank.updateMessage(profile.profileId, stored.id, { status: "matched", transactionId: manual });
      outcomes.push({ message: { ...stored, status: "matched", transactionId: manual }, outcome: "matched", feeRecorded });
      continue;
    }

    // Money from someone who owes the person, or to someone the person owes, is asked about even when Alfred knows the payee: it may be paying back.
    const settling = stored.direction === "in" ? owedBy : oweTo;
    if (deps.loans && learnable(stored.counterparty) && (await settling(deps.loans, profile.profileId, stored.counterparty))) {
      outcomes.push({ message: stored, outcome: "needs_label", feeRecorded });
      continue;
    }

    const rule = learnable(stored.counterparty) ? await deps.bank.getRule(profile.profileId, payeeKey(stored.counterparty)) : null;
    // A payee that funds an investment: the money goes in there, not into spending.
    if (rule?.kind === "investment" && deps.investments) {
      const investment = findInvestment(await deps.investments.list(profile.profileId), rule.description);
      if (investment) {
        await invest(deps, profile, stored, investment);
        outcomes.push({ message: { ...stored, status: "invested" }, outcome: "invested", category: investment.name, feeRecorded });
        continue;
      }
    }
    // Someone who chips in toward a bill: their money lowers that category's spending.
    if (rule?.kind === "chip_in") {
      const billCategory = stored.direction === "in" ? normalizeCategory(rule.category, "expense") : null;
      if (billCategory) {
        const id = await record(deps, profile, stored, { type: "expense", amount: `-${stored.amount}`, category: billCategory, description: rule.description || chipInDescription(stored) });
        await deps.bank.updateMessage(profile.profileId, stored.id, { status: "recorded", transactionId: id });
        outcomes.push({ message: { ...stored, status: "recorded", transactionId: id }, outcome: "recorded", category: billCategory, chipIn: true, feeRecorded });
      } else {
        outcomes.push({ message: stored, outcome: "needs_label", feeRecorded });
      }
      continue;
    }
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

/** Records a bank payment as money into (out, from the bank's side) or out of an investment. Returns the contribution's id. */
async function invest(deps: IngestDeps, profile: UserProfile, message: BankMessage, investment: Investment): Promise<string> {
  const contribution = await deps.investments!.addContribution(profile.profileId, {
    investmentId: investment.id,
    amount: message.direction === "out" ? message.amount : `-${message.amount}`,
    currency: message.currency,
    occurredOn: zonedYmd(new Date(message.occurredAt), profile.timezone),
    bankMessageId: message.id,
    note: describe(message),
  });
  await deps.bank.updateMessage(profile.profileId, message.id, { status: "invested" });
  return contribution.id;
}

/**
 * Links a new text to others about the same payment. Returns its outcome when
 * that settles it (a duplicate, or a fee), or null to carry on as usual. A
 * bare debit that may be a card payment already on hold is marked
 * `hold_settle` so it's asked about.
 */
async function linkRelated(deps: IngestDeps, profile: UserProfile, stored: BankMessage): Promise<Omit<IngestOutcome, "feeRecorded"> | null> {
  const around = await nearby(deps.bank, stored);
  if (isBare(stored)) {
    // The named text for the same payment already counts it; this one only adds the balance.
    const twin = namedTwin(stored, around);
    if (twin) {
      await deps.bank.updateMessage(profile.profileId, stored.id, { status: "matched", transactionId: twin.transactionId });
      return { message: { ...stored, status: "matched", transactionId: twin.transactionId }, outcome: "matched" };
    }
    const payment = feeFor(stored, around);
    if (payment) {
      const id = await record(deps, profile, stored, { type: "expense", amount: stored.amount, category: "Fees", description: feeDescription(stored, payment, titleCase) });
      await deps.bank.updateMessage(profile.profileId, stored.id, { status: "recorded", transactionId: id });
      return { message: { ...stored, status: "recorded", transactionId: id }, outcome: "recorded", category: "Fees" };
    }
    if (await holdFor(deps.bank, stored)) {
      await deps.bank.updateMessage(profile.profileId, stored.id, { kind: "hold_settle" });
      stored.kind = "hold_settle";
    }
  } else {
    const twin = bareTwin(stored, around);
    // Already filed from its bare twin, before the named text arrived: link to that.
    if (twin?.status === "recorded" && twin.transactionId) {
      await deps.bank.updateMessage(profile.profileId, stored.id, { status: "matched", transactionId: twin.transactionId });
      return { message: { ...stored, status: "matched", transactionId: twin.transactionId }, outcome: "matched" };
    }
    // Otherwise this named text is the one to ask about, and the bare one stops waiting.
    if (twin?.status === "needs_label") await deps.bank.updateMessage(profile.profileId, twin.id, { status: "matched" });
  }
  // Fee texts that arrived before the payment they belong to.
  for (const fee of feesAround(stored, around)) {
    const id = await record(deps, profile, fee, { type: "expense", amount: fee.amount, category: "Fees", description: feeDescription(fee, stored, titleCase) });
    await deps.bank.updateMessage(profile.profileId, fee.id, { status: "recorded", transactionId: id });
  }
  return null;
}

export type Label =
  /** `forMonth` (YYYY-MM) counts it in the month it's for, like November's rent paid in October. */
  | { kind: "category"; category: string; description?: string | null; forMonth?: string | null; includedFee?: string | null }
  | { kind: "transfer" }
  | { kind: "skip" }
  /** Money the person handled for someone else (received and passed on, or paid on their behalf), excluded from personal income and spending while keeping any bank fee. */
  | { kind: "pass_through"; person?: string | null; note?: string | null }
  /** A refund that lowers the spending category of the original purchase rather than counting as income. */
  | { kind: "refund"; category: string; description?: string | null }
  /** Money the person lent out; `person` names who, when the message doesn't. */
  | { kind: "lent"; person?: string | null; note?: string | null }
  /** Money coming back from someone who owed the person. */
  | { kind: "repaid"; person?: string | null }
  /** Money someone lent the person, which they now owe back. */
  | { kind: "borrowed"; person?: string | null; note?: string | null }
  /** The person paying back money they borrowed. */
  | { kind: "paid_back"; person?: string | null }
  /** Money into an investment (or out of it, for money coming in); `investment` names which, or the payee does. */
  | { kind: "invest"; investment?: string | null }
  /** Someone's share of a bill the person paid, like a housemate's part of the internet. */
  /** `person` is whose share it is when someone else sent it for them, like a friend paying on a housemate's behalf. */
  | { kind: "chip_in"; category: string; description?: string | null; person?: string | null };

export type LabelResult = { ok: true; text: string; changes: LabelChange[] } | { ok: false; text: string };

/** "Kofi Mensah's share", for a chip-in with no description of its own. */
function chipInDescription(message: BankMessage): string {
  return `${titleCase(message.counterparty) || "Someone"}'s share`;
}

/** Who a payment was to or from, as a name a person would say. */
function personFor(message: BankMessage, named?: string | null): string | null {
  const payee = learnable(message.counterparty) && classifyPayee(message.counterparty).kind === "person" ? titleCase(message.counterparty) : null;
  // "Debby" for a payment to DEBORAH AMA… is the payee, by their full name.
  if (named?.trim() && !(payee && findPerson([{ personKey: personKey(payee) }], named))) return titleCase(named.trim()).slice(0, 120);
  return payee;
}

const LOAN_KINDS = { lent: "loan_out", repaid: "loan_repay", borrowed: "loan_in", paid_back: "loan_repay" } as const;

/** Why a loan label can't fit the way the money moved, or null when it fits. */
function loanDirectionProblem(kind: keyof typeof LOAN_KINDS, direction: BankMessage["direction"], money: string): string | null {
  if (kind === "lent" && direction !== "out") return `${money} came in, so it can't be money you lent. Did someone lend it to you, or pay you back?`;
  if (kind === "repaid" && direction !== "in") return `${money} went out, so it can't be someone paying you back.`;
  if (kind === "borrowed" && direction !== "in") return `${money} went out, so it can't be money someone lent you. Did you lend it, or pay someone back?`;
  if (kind === "paid_back" && direction !== "out") return `${money} came in, so it can't be you paying someone back.`;
  return null;
}

/** What Alfred says after a loan label, with where things now stand with that person. */
async function loanReply(loans: LoanStore, ownerId: string, kind: keyof typeof LOAN_KINDS, person: string, money: string): Promise<string> {
  if (kind === "lent" || kind === "repaid") {
    const left = await owedBy(loans, ownerId, person);
    const owes = left ? `${person} owes you ${formatAmount(left.owed, left.currency)} in total.` : `${person} has paid you back in full.`;
    return kind === "lent" ? `Noted: you lent ${person} ${money}. It isn't counted as spending. ${owes}` : `Marked ${money} from ${person} as paying you back. ${owes}`;
  }
  const left = await oweTo(loans, ownerId, person);
  const owe = left ? `You owe ${person} ${formatAmount(left.owe, left.currency)} in total.` : `You've paid ${person} back in full.`;
  return kind === "borrowed" ? `Noted: ${person} lent you ${money}. It isn't counted as income. ${owe}` : `Marked ${money} to ${person} as paying them back. It isn't counted as spending. ${owe}`;
}

/**
 * Files a held message once the person says what it was, and remembers the
 * payee for next time unless `learn` is false (the person didn't name them).
 */
export async function applyLabel(deps: IngestDeps, profile: UserProfile, messageId: string, label: Label, options: { learn?: boolean } = {}): Promise<LabelResult> {
  const message = await deps.bank.getMessage(profile.profileId, messageId);
  if (!message) return { ok: false, text: "I couldn't find that payment anymore." };
  if (message.status !== "needs_label") return { ok: false, text: "That one is already sorted." };
  const money = formatAmount(message.amount, message.currency);
  const change: LabelChange = { messageId: message.id, previous: { status: message.status, kind: message.kind }, transactionIds: [] };

  if (label.kind === "skip") {
    // For a debit that may be a card payment on hold, skipping means "yes, the same payment": it already counts.
    const hold = message.kind === "hold_settle" ? await holdFor(deps.bank, message) : null;
    if (hold) {
      await deps.bank.updateMessage(profile.profileId, message.id, { status: "matched", transactionId: hold.transactionId });
      await deps.bank.updateMessage(profile.profileId, hold.id, { kind: "payment" });
      change.heldId = hold.id;
      const what = hold.counterparty ? `the ${titleCase(hold.counterparty)} payment` : "the card payment";
      return { ok: true, text: `Got it: ${money} was ${what} going through, so it's only counted once.`, changes: [change] };
    }
    await deps.bank.updateMessage(profile.profileId, message.id, { status: "skipped" });
    return { ok: true, text: `Left ${money} out of your books.`, changes: [change] };
  }
  if (label.kind === "pass_through") {
    await deps.bank.updateMessage(profile.profileId, message.id, { status: "skipped" });
    const who = (label.person?.trim() && titleCase(label.person.trim())) || (message.counterparty ? titleCase(message.counterparty) : "someone else");
    const feeNote = Number(message.fee) > 0 ? ` The ${formatAmount(message.fee, message.currency)} fee still counts under Fees.` : "";
    return {
      ok: true,
      text: `Noted: ${money} was money handled for ${who}, so it isn't counted as your ${message.direction === "out" ? "spending" : "income"}.${feeNote}`,
      changes: [change],
    };
  }
  if (label.kind === "refund") {
    if (message.direction !== "in") return { ok: false, text: `${money} went out, so it can't be a refund coming back.` };
    const refundCategory = normalizeCategory(label.category, "expense");
    if (!refundCategory) return { ok: false, text: "Which spending category was the refund for? Pick one from the list." };
    const sender = titleCase(message.counterparty);
    const description = `Refund · ${label.description?.trim() || sender || "Returned purchase"}`.slice(0, 200);
    const id = await record(deps, profile, message, { type: "expense", amount: `-${message.amount}`, category: refundCategory, description });
    await deps.bank.updateMessage(profile.profileId, message.id, { status: "recorded", transactionId: id });
    change.transactionIds.push(id);
    return {
      ok: true,
      text: `Counted ${money}${sender ? ` from ${sender}` : ""} as a refund under ${refundCategory}, so it lowers what you spent there instead of counting as income.`,
      changes: [change],
    };
  }
  if (label.kind === "transfer") {
    await deps.bank.updateMessage(profile.profileId, message.id, { status: "transfer", kind: "transfer_own" });
    // A named sender or recipient that is "my own money" is one of the person's own accounts; remember it.
    const named = learnable(message.counterparty) && classifyPayee(message.counterparty).kind === "person";
    if (named) await deps.bank.addAccountName(profile.profileId, titleCase(message.counterparty));
    return {
      ok: true,
      text: named
        ? `Noted. ${money} was your own money moving between accounts, so it isn't counted. I'll treat ${titleCase(message.counterparty)} as you from now on.`
        : `Noted. ${money} was your own money moving between accounts, so it isn't counted as income or spending.`,
      changes: [change],
    };
  }
  if (label.kind === "lent" || label.kind === "repaid" || label.kind === "borrowed" || label.kind === "paid_back") {
    if (!deps.loans) return { ok: false, text: "I can't track loans right now." };
    const wrongWay = loanDirectionProblem(label.kind, message.direction, money);
    if (wrongWay) return { ok: false, text: wrongWay };
    // Paying back only settles a debt Alfred knows about, so a guess can't invent one.
    const settles = label.kind === "repaid" ? owedBy : label.kind === "paid_back" ? oweTo : null;
    const named = label.person?.trim() || personFor(message, null) || "";
    const known = settles ? await settles(deps.loans, profile.profileId, named) : label.person ? await owedBy(deps.loans, profile.profileId, label.person) : null;
    if (settles && !known) {
      const who = named ? titleCase(named) : null;
      return {
        ok: false,
        text:
          label.kind === "repaid"
            ? `${who ?? "That person"} doesn't owe you anything that I know of, so ${money} can't be them paying you back. If they lent it to you, say so and I'll note that you owe them.`
            : `You don't owe ${who ?? "them"} anything that I know of, so I can't count ${money} as paying them back. Tell me what it was instead.`,
      };
    }
    const person = known?.person ?? personFor(message, label.person);
    if (!person) return { ok: false, text: label.kind === "lent" ? `Who did you lend the ${money} to?` : label.kind === "borrowed" ? `Who lent you the ${money}?` : `Who was the ${money} with?` };
    const entry = await deps.loans.add(profile.profileId, {
      person,
      kind: label.kind,
      amount: message.amount,
      currency: message.currency,
      occurredAt: message.occurredAt,
      note: label.kind === "lent" || label.kind === "borrowed" ? (label.note ?? "").trim() : "",
      bankMessageId: message.id,
    });
    await deps.bank.updateMessage(profile.profileId, message.id, { status: label.kind, kind: LOAN_KINDS[label.kind] });
    change.loanId = entry.id;
    return { ok: true, text: await loanReply(deps.loans, profile.profileId, label.kind, person, money), changes: [change] };
  }

  if (label.kind === "invest") {
    if (!deps.investments) return { ok: false, text: "I can't track investments right now." };
    const all = await deps.investments.list(profile.profileId);
    const key = learnable(message.counterparty) ? payeeKey(message.counterparty) : null;
    let investment = findInvestment(all, label.investment) ?? (key ? all.find((item) => item.payeeKey === key) ?? null : null) ?? findInvestment(all, message.counterparty);
    let created = false;
    if (!investment) {
      // An investment Alfred doesn't know yet: start one named after the payee, or the name the person gave.
      const name = (label.investment?.trim() || (key ? titleCase(message.counterparty) : "")).slice(0, 80);
      if (!name) return { ok: false, text: `Which investment did the ${money} go ${message.direction === "out" ? "into" : "out of"}?` };
      investment = await deps.investments.create(profile.profileId, { name, kind: "other", payeeKey: key });
      created = true;
    } else if (key && !investment.payeeKey) {
      await deps.investments.update(profile.profileId, investment.id, { payeeKey: key });
    }
    change.contributionId = await invest(deps, profile, message, investment);
    // The payee funds this investment from now on.
    if (key && options.learn !== false && !looksLikeOwner(message.counterparty, profile.preferredName)) {
      change.rule = { payeeKey: key, previous: await deps.bank.getRule(profile.profileId, key) };
      await deps.bank.saveRule(profile.profileId, { payeeKey: key, category: "Investments", description: investment.name, kind: "investment" });
    }
    const moved = message.direction === "out" ? `Put ${money} into ${investment.name}` : `Took ${money} out of ${investment.name}`;
    const later = key && options.learn !== false ? ` Payments ${message.direction === "out" ? "to" : "from"} ${titleCase(message.counterparty)} will go there from now on.` : "";
    const fresh = created ? ` I've started tracking ${investment.name}; tell me what it is (US stocks, a T-bill, a fund…) and what it's worth, and I'll keep its value.` : "";
    return { ok: true, text: `${moved}. It isn't counted as ${message.direction === "out" ? "spending" : "income"}.${later}${fresh}`, changes: [change] };
  }

  if (label.kind === "chip_in") {
    if (message.direction !== "in") return { ok: false, text: `${money} went out, so it can't be someone's share coming in.` };
    const billCategory = normalizeCategory(label.category, "expense");
    if (!billCategory) return { ok: false, text: "Which bill was it a share of? Pick a spending category." };
    const sender = titleCase(message.counterparty);
    // Money can come from someone paying on another person's behalf: the share is theirs, not the sender's.
    const owner = label.person?.trim() && !findPerson([{ personKey: personKey(sender) }], label.person) ? titleCase(label.person.trim()).slice(0, 120) : sender;
    const via = owner !== sender && sender ? `, sent by ${sender}` : "";
    const description = `${owner ? `${owner}'s share` : "A share"}${label.description?.trim() ? ` of ${label.description.trim()}` : ""}${via}`.slice(0, 200);
    const id = await record(deps, profile, message, { type: "expense", amount: `-${message.amount}`, category: billCategory, description });
    await deps.bank.updateMessage(profile.profileId, message.id, { status: "recorded", transactionId: id });
    change.transactionIds.push(id);
    // Someone who pays for other people may send money for other reasons too, so only a sender paying their own share is learned.
    const remembers = options.learn !== false && !via && learnable(message.counterparty) && !looksLikeOwner(message.counterparty, profile.preferredName);
    if (remembers) {
      const key = payeeKey(message.counterparty);
      change.rule = { payeeKey: key, previous: await deps.bank.getRule(profile.profileId, key) };
      await deps.bank.saveRule(profile.profileId, { payeeKey: key, category: billCategory, description, kind: "chip_in" });
    }
    return {
      ok: true,
      text: `Counted ${money}${via ? ` from ${sender} as ${owner}'s` : ` from ${sender || "them"} as their`} share of ${billCategory}, so it lowers what you spent there instead of counting as income.${remembers ? ` I'll treat money from ${sender} this way from now on.` : ""}`,
      changes: [change],
    };
  }

  const type = message.direction === "out" ? "expense" : "income";
  const category = normalizeCategory(label.category, type);
  if (!category) return { ok: false, text: "That category doesn't fit. Pick one from the list." };
  const splitFee = label.includedFee ? canonicalizeAmount(label.includedFee) : null;
  if (label.includedFee && (!splitFee || type !== "expense" || toMinor(splitFee) <= 0 || toMinor(splitFee) >= toMinor(message.amount))) {
    return { ok: false, text: `The included fee must be less than ${money}.` };
  }
  const principalAmount = splitFee ? ((toMinor(message.amount) - toMinor(splitFee)) / 100).toFixed(2) : message.amount;
  const paidOn = zonedYmd(new Date(message.occurredAt), profile.timezone);
  const countsIn = monthItsFor(paidOn, label.forMonth, label.description);
  const description = `${label.description?.trim() || describe(message)}${countsIn ? ` (paid ${formatDisplayDate(paidOn).replace(/ \d{4}$/, "")})` : ""}`;
  const dateOverride = countsIn ? `${countsIn}-01` : undefined;
  const id = await record(deps, profile, message, { type, amount: principalAmount, category, description, date: dateOverride });
  await deps.bank.updateMessage(profile.profileId, message.id, { status: "recorded", transactionId: id });
  change.transactionIds.push(id);
  if (splitFee) {
    const feeId = await record(deps, profile, message, {
      type: "expense",
      amount: splitFee,
      category: "Fees",
      description: `Fees · ${description}`,
      suffix: ":included-fee",
      date: dateOverride,
    });
    change.transactionIds.push(feeId);
  }
  const changes = [change];
  const remembers = options.learn !== false && learnable(message.counterparty) && !VAGUE.has(category) && !looksLikeOwner(message.counterparty, profile.preferredName);
  let alsoFiled = 0;
  if (remembers) {
    const key = payeeKey(message.counterparty);
    const ruleDescription = label.description?.trim() ? description : "";
    change.rule = { payeeKey: key, previous: await deps.bank.getRule(profile.profileId, key) };
    await deps.bank.saveRule(profile.profileId, { payeeKey: key, category, description: ruleDescription });
    // Other payments to the same payee that were waiting can be filed now too.
    const same = (await deps.bank.listMessages(profile.profileId, "needs_label")).filter(
      (item) => item.direction === message.direction && payeeKey(item.counterparty) === key,
    );
    for (const item of same) {
      const otherId = await record(deps, profile, item, { type, amount: item.amount, category, description: ruleDescription || describe(item) });
      await deps.bank.updateMessage(profile.profileId, item.id, { status: "recorded", transactionId: otherId });
      changes.push({ messageId: item.id, previous: { status: item.status, kind: item.kind }, transactionIds: [otherId] });
      alsoFiled += 1;
    }
  }
  const who = titleCase(message.counterparty);
  const extra = alsoFiled > 0 ? ` I've also filed ${alsoFiled} other payment${alsoFiled === 1 ? "" : "s"} to ${who} the same way.` : "";
  const feeSplitNote = splitFee ? ` (${formatAmount(principalAmount, message.currency)} under ${category} + ${formatAmount(splitFee, message.currency)} under Fees)` : "";
  return {
    ok: true,
    text: `Filed ${money} under ${category}${feeSplitNote}${countsIn ? `, counted in ${monthName(countsIn)} since that's the month it's for` : ""}.${remembers ? ` I'll file ${who} as ${category} from now on.${extra}` : ""}`,
    changes,
  };
}

/**
 * Stops counting texts from an account that isn't the person's money, like a
 * parent's account they manage: notes it in their notebook so future texts are
 * left out, skips payments from it still waiting for a label, and forgets its
 * balances. Returns how many waiting payments it skipped.
 */
export async function ignoreAccount(bank: BankStore, notebook: NotebookStore, ownerId: string, account: string, note: string): Promise<number> {
  await notebook.add(ownerId, { note, account });
  let skipped = 0;
  for (const message of await bank.listMessages(ownerId)) {
    if (accountOf(message.raw) !== account) continue;
    const waiting = message.status === "needs_label";
    if (waiting) skipped += 1;
    await bank.updateMessage(ownerId, message.id, { ...(waiting ? { status: "skipped" as const } : {}), balance: null });
  }
  return skipped;
}

/** What the main conversation may do with the person's bank texts. */
export function bankAccess(bank: BankStore, notebook: NotebookStore | null | undefined, ownerId: string): BankAccess {
  return {
    ignoreAccount: notebook ? (account, note) => ignoreAccount(bank, notebook, ownerId, account, note) : null,
    balances: () => bank.latestBalances(ownerId),
  };
}

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function monthName(month: string): string {
  const name = MONTH_NAMES[Number(month.slice(5, 7)) - 1];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * The month (YYYY-MM) a payment should count in when it's for a different
 * month from the one it was paid in: given outright, or read from a
 * description like "House contribution for November". Only a month or two
 * either side counts, so "for May" in October isn't taken literally.
 */
export function monthItsFor(paidOn: string, forMonth?: string | null, description?: string | null): string | null {
  const paid = paidOn.slice(0, 7);
  let month = forMonth && /^\d{4}-\d{2}$/.test(forMonth) ? forMonth : null;
  if (!month && description) {
    const named = description.toLowerCase().match(new RegExp(`\\bfor (${MONTH_NAMES.join("|")})\\b`))?.[1];
    if (named) {
      const year = Number(paid.slice(0, 4));
      const index = MONTH_NAMES.indexOf(named) + 1;
      const candidates = [year - 1, year, year + 1].map((item) => `${item}-${String(index).padStart(2, "0")}`);
      month = candidates.reduce((best, item) => (Math.abs(monthsBetween(paid, item)) < Math.abs(monthsBetween(paid, best)) ? item : best));
    }
  }
  if (!month || month === paid) return null;
  const gap = monthsBetween(paid, month);
  return gap >= -1 && gap <= 2 ? month : null;
}

function monthsBetween(from: string, to: string): number {
  return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));
}

/** Puts back everything a batch of labels changed, newest first. Returns how many payments were reopened. */
export async function undoLabels(deps: IngestDeps, profile: UserProfile, changes: LabelChange[]): Promise<number> {
  let reopened = 0;
  for (const change of [...changes].reverse()) {
    for (const id of change.transactionIds) {
      await deps.ledger.updateTransaction(profile.profileId, id, { status: "deleted" }).catch(() => undefined);
    }
    if (change.loanId && deps.loans) await deps.loans.remove(profile.profileId, change.loanId);
    if (change.heldId) await deps.bank.updateMessage(profile.profileId, change.heldId, { kind: "card_hold" });
    if (change.contributionId && deps.investments) await deps.investments.removeContribution(profile.profileId, change.contributionId);
    if (change.rule) {
      if (change.rule.previous) await deps.bank.saveRule(profile.profileId, change.rule.previous);
      else await deps.bank.deleteRule(profile.profileId, change.rule.payeeKey);
    }
    await deps.bank.updateMessage(profile.profileId, change.messageId, { status: change.previous.status, kind: change.previous.kind, transactionId: null });
    reopened += 1;
  }
  return reopened;
}

/** The question Alfred asks about a held payment. */
export function labelQuestion(
  message: BankMessage,
  timeZone: string,
  ownerName = "",
  debt?: { person: string; owed: string; owe: string } | null,
  hold?: BankMessage | null,
): string {
  const money = formatAmount(message.amount, message.currency);
  const when = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone }).format(
    new Date(message.occurredAt),
  );
  // A text from a bank Alfred has no rules for: say so, so a misreading gets caught.
  const learning = message.readBy === "model" ? ` (I read this ${sourceName(message.source)} text myself. If I got it wrong, tap Skip.)` : "";
  return `${baseQuestion(message, timeZone, ownerName, debt, hold, money, when)}${learning}`;
}

function baseQuestion(
  message: BankMessage,
  timeZone: string,
  ownerName: string,
  debt: { person: string; owed: string; owe: string } | null | undefined,
  hold: BankMessage | null | undefined,
  money: string,
  when: string,
): string {
  if (message.kind === "hold_settle") {
    const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone }).format(new Date(hold?.occurredAt ?? message.occurredAt));
    const what = hold?.counterparty ? `the ${titleCase(hold.counterparty)} card payment from ${day}` : "a card payment";
    return `${money} left your ${sourceName(message.source)} account · ${when}. It matches ${what} that was on hold, which I've already counted. Is this the same payment going through?`;
  }
  if (debt && message.direction === "in" && Number(debt.owed) > 0) {
    return `${money} came in from ${titleCase(message.counterparty)} · ${when}. ${debt.person} owes you ${formatAmount(debt.owed, message.currency)}. Is this paying you back?`;
  }
  if (debt && message.direction === "out" && Number(debt.owe) > 0) {
    return `${money} went to ${titleCase(message.counterparty)} · ${when}. You owe ${debt.person} ${formatAmount(debt.owe, message.currency)}. Is this paying them back?`;
  }
  if (looksLikeOwner(message.counterparty, ownerName)) {
    const who = titleCase(message.counterparty);
    return message.direction === "in"
      ? `${money} came in from ${who} · ${when}. That looks like you. Was it your own money moving from another account, or something else?`
      : `${money} went to ${who} · ${when}. That looks like you. Was it a transfer to your own account, or something else?`;
  }
  const payee = classifyPayee(message.counterparty);
  if (payee.kind === "channel") {
    const network = titleCase(message.counterparty);
    return message.direction === "out"
      ? `${money} sent from MoMo to ${payee.channel} (${network}) · ${when}. These transfers don't say who received the money. Who was it to, and what for?`
      : `${money} came in from ${payee.channel} (${network}) · ${when}. Who sent it, and what was it?`;
  }
  if (message.direction === "out") {
    const to =
      message.counterparty && !/^gcb/i.test(message.counterparty)
        ? ` to ${titleCase(message.counterparty)}`
        : message.source === "gcb"
          ? " on your GCB card"
          : ` from your ${sourceName(message.source)} account`;
    return `${money}${to} · ${when}${said(message)}. What was that for?`;
  }
  const from =
    message.counterparty && !/^gcb/i.test(message.counterparty)
      ? ` from ${titleCase(message.counterparty)}`
      : message.source === "gcb"
        ? " onto your GCB card"
        : ` into your ${sourceName(message.source)} account`;
  return `${money} came in${from} · ${when}${said(message)}. What was it?`;
}

/** The sender's own note on a payment, quoted, when the text has one. */
function said(message: BankMessage): string {
  const purpose = purposeOf(message);
  return purpose ? `, marked “${purpose}”` : "";
}
