import { isOwnName, parseBankText, payeeKey, purposeOf, withoutRecipient, type ParsedBankMessage } from "@/lib/bank/parse";
import { classifyPayee } from "@/lib/bank/payees";
import type { BankMessage, BankStore, LabelChange } from "@/lib/bank/store";
import type { UserProfile } from "@/lib/config";
import { normalizeCategory } from "@/lib/finance/categories";
import { addDays, zonedYmd } from "@/lib/finance/dates";
import type { PeopleStore } from "@/lib/people/store";
import { findPerson, owedBy, oweTo, personKey, type LoanStore } from "@/lib/finance/loans";
import { formatAmount } from "@/lib/finance/money";
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
};

export type IngestOutcome = {
  message: BankMessage;
  outcome: "matched" | "recorded" | "needs_label" | "transfer" | "loan" | "skipped";
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

export type Label =
  | { kind: "category"; category: string; description?: string | null }
  | { kind: "transfer" }
  | { kind: "skip" }
  /** Money the person lent out; `person` names who, when the message doesn't. */
  | { kind: "lent"; person?: string | null; note?: string | null }
  /** Money coming back from someone who owed the person. */
  | { kind: "repaid"; person?: string | null }
  /** Money someone lent the person, which they now owe back. */
  | { kind: "borrowed"; person?: string | null; note?: string | null }
  /** The person paying back money they borrowed. */
  | { kind: "paid_back"; person?: string | null }
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
    await deps.bank.updateMessage(profile.profileId, message.id, { status: "skipped" });
    return { ok: true, text: `Left ${money} out of your books.`, changes: [change] };
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
  const description = label.description?.trim() || describe(message);
  const id = await record(deps, profile, message, { type, amount: message.amount, category, description });
  await deps.bank.updateMessage(profile.profileId, message.id, { status: "recorded", transactionId: id });
  change.transactionIds.push(id);
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
  return {
    ok: true,
    text: remembers
      ? `Filed ${money} under ${category}. I'll file ${who} as ${category} from now on.${extra}`
      : `Filed ${money} under ${category}.`,
    changes,
  };
}

/** Puts back everything a batch of labels changed, newest first. Returns how many payments were reopened. */
export async function undoLabels(deps: IngestDeps, profile: UserProfile, changes: LabelChange[]): Promise<number> {
  let reopened = 0;
  for (const change of [...changes].reverse()) {
    for (const id of change.transactionIds) {
      await deps.ledger.updateTransaction(profile.profileId, id, { status: "deleted" }).catch(() => undefined);
    }
    if (change.loanId && deps.loans) await deps.loans.remove(profile.profileId, change.loanId);
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
export function labelQuestion(message: BankMessage, timeZone: string, ownerName = "", debt?: { person: string; owed: string; owe: string } | null): string {
  const money = formatAmount(message.amount, message.currency);
  const when = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone }).format(
    new Date(message.occurredAt),
  );
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
    const to = message.counterparty && !/^gcb/i.test(message.counterparty) ? ` to ${titleCase(message.counterparty)}` : " on your GCB card";
    return `${money}${to} · ${when}${said(message)}. What was that for?`;
  }
  const from = message.counterparty && !/^gcb/i.test(message.counterparty) ? ` from ${titleCase(message.counterparty)}` : " onto your GCB card";
  return `${money} came in${from} · ${when}${said(message)}. What was it?`;
}

/** The sender's own note on a payment, quoted, when the text has one. */
function said(message: BankMessage): string {
  const purpose = purposeOf(message);
  return purpose ? `, marked “${purpose}”` : "";
}
