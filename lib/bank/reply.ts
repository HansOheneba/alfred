import { applyLabel, titleCase, undoLabels, type IngestDeps, type Label } from "@/lib/bank/ingest";
import { NATURAL_HINT, labelChoiceText, labelFromCode, parseLabelCallback, questionFor, reviewRow } from "@/lib/bank/notify";
import { accountOf, payeeKey, purposeOf, sourceName } from "@/lib/bank/parse";
import { classifyPayee } from "@/lib/bank/payees";
import { holdFor } from "@/lib/bank/related";
import type { BankMessage, LabelChange } from "@/lib/bank/store";
import type { UserProfile } from "@/lib/config";
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, normalizeCategory } from "@/lib/finance/categories";
import { zonedYmd } from "@/lib/finance/dates";
import { findPerson, loanBalances } from "@/lib/finance/loans";
import type { LabelAnswer } from "@/lib/finance/schemas";
import { formatAmount } from "@/lib/finance/money";
import { logError } from "@/lib/log";
import type { InlineButton } from "@/lib/telegram/client";
import { PAYMENT_NOTICE_STAYS_PENDING } from "./notice-policy";

/** How long "undo" reverses labels rather than meaning something else. */
const UNDO_WINDOW_MS = 30 * 60_000;
/** How many waiting payments the model sees at once, oldest first. */
const MAX_LISTED = 40;
/**
 * Turns with payments waiting use the stronger model: matching many payments
 * to a loose sentence makes the small one guess, e.g. filing every unnamed
 * payment as "office snacks".
 */
export const LABEL_MODEL = "deepseek-v4-pro";

/** One instruction from the person: these payments get this label. */
export type ResolvedLabel = { messageIds: string[]; label: Label };

/** The payments waiting for a label, as Alfred's main conversation sees them. */
export type WaitingPayments = {
  all: BankMessage[];
  /**
   * Payments the last label just filed, which the person may be correcting
   * ("no, I mean he lent it to me"), with what each change did.
   */
  recent: { message: BankMessage; change: LabelChange }[];
  /** The oldest waiting ones, then the just-filed ones, numbered from 1 in `lines`. */
  listed: BankMessage[];
  lines: string[];
  /** The payment the person was just asked about; a bare reply answers it. */
  current: BankMessage | null;
  /** Its number in `lines`, or 0. */
  currentNumber: number;
  /** A reply to one private notice must not learn a rule or file other payments. */
  exactQuestion?: boolean;
};

/**
 * A private payment notice names its own question. An explicit null means the
 * last notice wasn't a question, or is no longer open; never reuse an older one.
 */
export type PaymentQuestionFocus = { currentMessageId?: string | null };

/** Works out which payments a message is about and what each was, e.g. from the main conversation's answer. */
export type LabelResolver = (input: { text: string; waiting: WaitingPayments; profile: UserProfile }) => Promise<ResolvedLabel[]>;

function listLine(message: BankMessage, index: number, profile: UserProfile, debts: Map<string, string>, filedAs?: string, held?: string): string {
  const money = formatAmount(message.amount, message.currency);
  const when = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: profile.timezone }).format(
    new Date(message.occurredAt),
  );
  const payee = classifyPayee(message.counterparty);
  const name = message.counterparty ? titleCase(message.counterparty) : message.source === "gcb" ? "GCB card" : `${sourceName(message.source)} account (no payee named)`;
  const who =
    payee.kind === "channel" ? `${name} (sent to ${payee.channel}; the recipient isn't named)` : name;
  const debt = debts.get(message.id);
  const purpose = purposeOf(message);
  const owing = debt ? (message.direction === "in" ? ` · this person owes the user ${debt}` : ` · the user owes this person ${debt}`) : "";
  const filed = filedAs ? ` · JUST FILED as ${filedAs}` : "";
  // "Yes, it's the same one" for a possible card-hold debit is a skip: the hold already counted it.
  const hold = held ? ` · may be ${held} that was on hold and is already counted; if the user says it's the same payment, use skip` : "";
  const account = accountOf(message.raw);
  return `${index + 1}. ${message.direction === "out" ? "OUT" : "IN"} ${money} ${message.direction === "out" ? "to" : "from"} ${who} · ${when}${account ? ` · account ending ${account}` : ""}${purpose ? ` · marked "${purpose}"` : ""}${owing}${hold}${filed}`;
}

/** What a label filed a payment as, in a few words, e.g. "Transport · Okada" or "paying you back". */
export function filedAs(label: Label): string {
  if (label.kind === "category") return label.description ? `${label.category} · ${label.description}` : label.category;
  if (label.kind === "chip_in") return `${label.person ? `${label.person}'s` : "their"} share of ${label.category}`;
  if (label.kind === "refund") return `a refund under ${label.category}`;
  if (label.kind === "pass_through") return `money handled for ${label.person ?? "someone else"}`;
  if (label.kind === "transfer") return "the user's own money";
  if (label.kind === "skip") return "left out";
  if (label.kind === "lent") return "money the user lent";
  if (label.kind === "invest") return `money into ${label.investment ?? "an investment"}`;
  if (label.kind === "repaid") return "paying the user back";
  if (label.kind === "borrowed") return "money lent to the user";
  return "the user paying back a debt";
}

/**
 * What's waiting for a label, plus what the last label just filed, numbered
 * for the model, or null when there's neither.
 */
export async function waitingPayments(deps: IngestDeps, profile: UserProfile, focus: PaymentQuestionFocus = {}): Promise<WaitingPayments | null> {
  const all = oldestFirst(await deps.bank.listMessages(profile.profileId, "needs_label"));
  const explicit = focus.currentMessageId !== undefined;
  // An answer to a new notice must not silently correct a different, recently
  // filed payment. Corrections remain available in the normal conversation.
  const recent = explicit ? [] : await justFiled(deps, profile);
  if (all.length === 0 && recent.length === 0) return null;
  const current = explicit
    ? all.find((item) => item.id === focus.currentMessageId) ?? null
    : [...all].filter((item) => item.askedAt).sort((left, right) => (right.askedAt ?? "").localeCompare(left.askedAt ?? ""))[0] ?? null;
  const oldest = all.slice(0, MAX_LISTED);
  // The exact notice can be newer than forty older questions. Keep it in the
  // bounded model context, otherwise its number would be zero and replies lost.
  if (current && !oldest.some((item) => item.id === current.id)) oldest.splice(MAX_LISTED - 1, 1, current);
  const listed = [...oldest, ...recent.map((item) => item.message)];
  const debts = new Map<string, string>();
  if (deps.loans && listed.some((message) => message.counterparty.trim())) {
    const balances = loanBalances(await deps.loans.list(profile.profileId));
    const owing = balances.filter((item) => Number(item.owe) > 0);
    for (const message of listed) {
      if (!message.counterparty.trim()) continue;
      const matched = findPerson(message.direction === "in" ? balances : owing, message.counterparty);
      const debt = message.direction === "in" && matched && Number(matched.owed) <= 0 ? null : matched;
      if (debt) debts.set(message.id, formatAmount(message.direction === "in" ? debt.owed : debt.owe, debt.currency));
    }
  }
  const holds = new Map<string, string>();
  for (const message of listed.filter((item) => item.kind === "hold_settle" && item.status === "needs_label")) {
    const hold = await holdFor(deps.bank, message);
    holds.set(message.id, hold?.counterparty ? `the ${titleCase(hold.counterparty)} card payment` : "a card payment");
  }
  return {
    all,
    recent,
    listed,
    lines: listed.map((message, index) =>
      listLine(message, index, profile, debts, recent.find((item) => item.message.id === message.id)?.change.filedAs, holds.get(message.id)),
    ),
    current,
    currentNumber: current ? listed.findIndex((item) => item.id === current.id) + 1 : 0,
    exactQuestion: explicit,
  };
}

/** The payments the last label filed, while "undo" could still reverse it. */
async function justFiled(deps: IngestDeps, profile: UserProfile): Promise<WaitingPayments["recent"]> {
  const changes = await deps.bank.peekUndo(profile.profileId, new Date(deps.now.getTime() - UNDO_WINDOW_MS));
  const recent: WaitingPayments["recent"] = [];
  for (const change of changes ?? []) {
    const message = await deps.bank.getMessage(profile.profileId, change.messageId);
    if (message && message.status !== "needs_label") recent.push({ message, change });
  }
  return recent;
}

/** Turns the model's numbered answers back into payments and labels. */
export function resolvedFrom(answers: LabelAnswer[], listed: BankMessage[]): ResolvedLabel[] {
  return answers
    .map((answer): ResolvedLabel | null => {
      const messageIds = [...new Set(answer.items)].map((number) => listed[number - 1]?.id).filter((id): id is string => Boolean(id));
      if (messageIds.length === 0) return null;
      if (answer.action === "skip") return { messageIds, label: { kind: "skip" } };
      if (answer.action === "own_transfer") return { messageIds, label: { kind: "transfer" } };
      if (answer.action === "pass_through") return { messageIds, label: { kind: "pass_through", person: answer.person ?? null, note: answer.description ?? null } };
      if (answer.action === "lent") return { messageIds, label: { kind: "lent", person: answer.person ?? null, note: answer.description ?? null } };
      if (answer.action === "repaid") return { messageIds, label: { kind: "repaid", person: answer.person ?? null } };
      if (answer.action === "borrowed") return { messageIds, label: { kind: "borrowed", person: answer.person ?? null, note: answer.description ?? null } };
      if (answer.action === "paid_back") return { messageIds, label: { kind: "paid_back", person: answer.person ?? null } };
      if (answer.action === "investment") return { messageIds, label: { kind: "invest", investment: answer.investment ?? answer.description ?? null } };
      if (!answer.category) return null;
      if (answer.action === "refund") return { messageIds, label: { kind: "refund", category: answer.category, description: answer.description ?? null } };
      if (answer.action === "chip_in") return { messageIds, label: { kind: "chip_in", category: answer.category, description: answer.description ?? null, person: answer.person ?? null } };
      return {
        messageIds,
        label: {
          kind: "category",
          category: answer.category,
          description: answer.description ?? null,
          forMonth: answer.for_month ?? null,
          ...(answer.included_fee ? { includedFee: answer.included_fee } : {}),
        },
      };
    })
    .filter((item): item is ResolvedLabel => item !== null);
}

/** When the model says a message labels payments but none it picked fit what was said. */
export const UNMATCHED_LABEL =
  "I couldn't tell which waiting payments you meant. Name the person or the amount, like “the 125 from Kofi was a gift”, or ask “what are those?” to see them all.";

export type LabelReply = { text: string; next: BankMessage | null; buttons?: InlineButton[][] };

/** How many waiting payments "what are those?" lists before saying how many more. */
const MAX_SHOWN = 15;

/** One waiting payment as a short line: "GH₵61.50 to Godwin Abaya · Mon 26 Oct". */
export function waitingLine(message: BankMessage, profile: UserProfile): string {
  const money = formatAmount(message.amount, message.currency);
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: profile.timezone }).format(new Date(message.occurredAt));
  const named = message.counterparty && !/^gcb/i.test(message.counterparty) ? titleCase(message.counterparty) : null;
  const who = message.direction === "out" ? (named ? `to ${named}` : "on your GCB card") : named ? `from ${named}` : "onto your GCB card";
  return `${money} ${who} · ${day}`;
}

/** "What are those?", "which ones?", "show me" while payments are waiting. */
const LIST_QUERY = /^(?:what|which)\b.*\b(?:those|they|them|ones|payments?)\b|^(?:show|list)\b.*\b(?:them|those|payments?)\b|^(?:what's|whats) (?:left|pending|waiting)/i;
/** "Ask", "ask your questions", "no I mean ask me": the person wants the next question now. */
const ASK = /^(?:(?:no,?\s+)?i\s+mean\s+|ok(?:ay)?,?\s+|go\s+ahead,?\s+(?:and\s+)?|yes,?\s+|please\s+)?ask(?:\s+(?:me|away|now|them))?(?:\s+(?:your|the|those|my)\s+questions?)?(?:\s+(?:now|please))?\s*[.!]*$/i;
const UNDO = /^\s*(?:undo|undo (?:that|it|those|this)|revert (?:that|it))\s*[.!]?\s*$/i;

/** Shared so a new private notice cannot make "undo" target an older batch. */
export function isLabelUndo(text: string): boolean { return UNDO.test(text); }

/** "The rest were…", "all of them", "both": the person means every waiting payment. */
const EVERYTHING = /\b(?:the rest|the others|all the others|everything else|all (?:of )?(?:them|those|these)|remaining|both)\b/i;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
/** Words that look like the start of a name but are part of the instruction. */
const NOT_NAMES = new Set(
  [
    ...EXPENSE_CATEGORIES,
    ...INCOME_CATEGORIES,
    ...["was", "were", "with", "from", "going", "money", "that", "this", "those", "these", "them", "they", "everything", "every", "each"],
    ...["payment", "payments", "sent", "paid", "loan", "lent", "back", "rest", "others", "office", "snacks", "lunch", "airtime", "data", "fuel", "gift"],
  ].map((word) => word.toLowerCase()),
);

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z]+/g) ?? [];
}

/**
 * Whether a word in the message refers to this name: the same word, or a
 * nickname sharing its first three letters (Debby, Deborah). Short names
 * only match exactly, so "Samuel" doesn't point at Amos Sekyi Sam.
 */
function namesIt(said: string[], name: string): boolean {
  const tokens = words(name);
  return said.some((word) =>
    tokens.some((token) => token === word || (word.length >= 4 && !NOT_NAMES.has(word) && token.length >= 4 && token.slice(0, 3) === word.slice(0, 3))),
  );
}

type Pointer = "name" | "amount" | "date" | "everything";

/**
 * How the person's message points at a payment, or null when it doesn't. The
 * model picks the payments, but only the ones the message really points at
 * get filed, so a guess can't spread a label onto payments never mentioned.
 */
function pointsAt(text: string, message: BankMessage, profile: UserProfile, now: Date): Pointer | null {
  const said = words(text);
  if (message.counterparty ? namesIt(said, message.counterparty) : message.source === "gcb" && (said.includes("gcb") || said.includes("card"))) return "name";
  const amounts = (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((value) => Number(value.replace(/,/g, "")));
  if (amounts.some((value) => Math.abs(value - Number(message.amount)) < 0.005)) return "amount";
  const occurred = new Date(message.occurredAt);
  const weekday = WEEKDAYS[new Date(`${zonedYmd(occurred, profile.timezone)}T12:00:00Z`).getUTCDay()];
  const day = zonedYmd(occurred, profile.timezone);
  if (said.some((word) => word.length >= 3 && word.slice(0, 3) === weekday && /^(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?$/.test(word))) return "date";
  if (said.includes("today") && day === zonedYmd(now, profile.timezone)) return "date";
  if (said.includes("yesterday") && day === zonedYmd(new Date(now.getTime() - 86_400_000), profile.timezone)) return "date";
  if (EVERYTHING.test(text)) return "everything";
  return null;
}

/**
 * People the message names who were already sorted, so the person knows why
 * nothing changed for them. Only whole names count, not nicknames: "debited"
 * mustn't read as Deborah, nor "Oheneba" as Ellen Ohenewa. The person's own
 * names are never mentioned.
 */
async function alreadySorted(deps: IngestDeps, profile: UserProfile, text: string, waiting: BankMessage[]): Promise<string[]> {
  const said = new Set(words(text));
  const own = new Set([profile.preferredName, ...(await deps.bank.accountNames(profile.profileId))].flatMap(words));
  const waitingKeys = new Set(waiting.map((item) => payeeKey(item.counterparty)));
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const message of await deps.bank.listMessages(profile.profileId)) {
    const key = payeeKey(message.counterparty);
    if (message.status === "needs_label" || !key || seen.has(key) || waitingKeys.has(key)) continue;
    const tokens = words(message.counterparty);
    if (tokens.some((token) => own.has(token)) || !tokens.some((token) => token.length >= 3 && !NOT_NAMES.has(token) && said.has(token))) continue;
    seen.add(key);
    const rule = await deps.bank.getRule(profile.profileId, key);
    const filedUnder = rule ? `: I file them under ${rule.category}${rule.description ? ` · ${rule.description}` : ""}` : "";
    notes.push(`${titleCase(message.counterparty)} is already sorted${filedUnder}. Tell me if that should change.`);
    if (notes.length >= 3) break;
  }
  return notes;
}

function oldestFirst(messages: BankMessage[]): BankMessage[] {
  return [...messages].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
}

/**
 * Picks the oldest payment still waiting for a label and marks it as the one
 * being asked about now, so the next typed reply answers it.
 */
export async function askNext(deps: IngestDeps, profile: UserProfile): Promise<BankMessage | null> {
  const next = oldestFirst(await deps.bank.listMessages(profile.profileId, "needs_label"))[0] ?? null;
  if (next) await deps.bank.updateMessage(profile.profileId, next.id, { askedAt: deps.now.toISOString() });
  return next;
}

/** Appends the next question, with its buttons, to a reply. */
async function withNext(deps: IngestDeps, profile: UserProfile, text: string, intro: (remaining: number) => string): Promise<LabelReply> {
  const next = await askNext(deps, profile);
  if (!next) return { text, next: null };
  const remaining = (await deps.bank.listMessages(profile.profileId, "needs_label")).length;
  const question = await questionFor(deps.loans, profile, next, deps.people, deps.bank);
  return { text: `${text}\n\n${intro(remaining)}${question.text}`, next, buttons: [...question.buttons, ...reviewRow(remaining)] };
}

const nextIntro = (remaining: number) => (remaining > 1 ? `Next (${remaining - 1} more after this): ` : "Last one: ");

/** Asks about the same payment again, when the person's answer to it couldn't be read. */
export async function askAgain(deps: IngestDeps, profile: UserProfile, message: BankMessage, intro = "Sorry, I didn't quite catch that."): Promise<LabelReply> {
  const remaining = (await deps.bank.listMessages(profile.profileId, "needs_label")).length;
  const question = await questionFor(deps.loans, profile, message, deps.people, deps.bank);
  return { text: `${intro}\n\n${question.text}`, next: message, buttons: [...question.buttons, ...reviewRow(remaining)] };
}

/** The payment the person was asked about last and its answer buttons, or null when none is open. */
export async function currentQuestion(deps: IngestDeps, profile: UserProfile, focus: PaymentQuestionFocus = {}): Promise<{ message: BankMessage; buttons: InlineButton[][] } | null> {
  const explicit = focus.currentMessageId !== undefined;
  const asked = explicit ? [] : (await deps.bank.listMessages(profile.profileId, "needs_label")).filter((item) => item.askedAt);
  const message = explicit
    ? focus.currentMessageId ? await deps.bank.getMessage(profile.profileId, focus.currentMessageId) : null
    : asked.sort((left, right) => (right.askedAt ?? "").localeCompare(left.askedAt ?? ""))[0];
  if (!message || message.ownerId !== profile.profileId || message.status !== "needs_label") return null;
  const question = await questionFor(deps.loans, profile, message, deps.people, deps.bank);
  return { message, buttons: question.buttons };
}

/**
 * A tapped answer button (`b:<message id>:<code>`): files that payment and asks
 * the next one. `said` is what the tap reads as in the conversation.
 */
export async function chooseLabel(deps: IngestDeps, profile: UserProfile, data: string, options: { learn?: boolean; messageId?: string; next?: boolean } = {}): Promise<{ said: string; reply: LabelReply } | null> {
  const choice = parseLabelCallback(data);
  if (options.messageId !== undefined && choice?.messageId !== options.messageId) return null;
  const message = choice ? await deps.bank.getMessage(profile.profileId, choice.messageId) : null;
  const label = message && choice ? labelFromCode(message, choice.code) : null;
  if (!message || !label) return null;
  if (label.kind === "skip" && message.kind !== "hold_settle" && message.status === "needs_label") {
    const question = await questionFor(deps.loans, profile, message, deps.people, deps.bank);
    return { said: "Leave this payment pending", reply: { text: PAYMENT_NOTICE_STAYS_PENDING, next: message, buttons: question.buttons } };
  }
  const said = message.kind === "hold_settle" && label.kind === "skip" ? "Yes, same payment" : labelChoiceText(label);
  const result = await applyLabel(deps, profile, message.id, label, options);
  if (!result.ok) return { said, reply: { text: result.text, next: null } };
  await deps.bank.saveUndo(profile.profileId, result.changes);
  return { said, reply: options.next === false ? { text: `✓ ${result.text}`, next: null } : await withNext(deps, profile, `✓ ${result.text}`, nextIntro) };
}

/** The next waiting payment's question with its buttons, or null when nothing is waiting. */
export async function askNextReply(deps: IngestDeps, profile: UserProfile): Promise<LabelReply | null> {
  const count = (await deps.bank.listMessages(profile.profileId, "needs_label")).length;
  if (count === 0) return null;
  return withNext(deps, profile, count === 1 ? "One payment is waiting for a label." : `${count} payments are waiting for a label.`, () => "First: ");
}

/** "undo" and "what are those?" while payments are waiting: answered without the model. */
export async function labelShortcut(deps: IngestDeps, profile: UserProfile, text: string): Promise<LabelReply | null> {
  if (isLabelUndo(text)) {
    const changes = await deps.bank.takeUndo(profile.profileId, new Date(deps.now.getTime() - UNDO_WINDOW_MS));
    if (changes) {
      const reopened = await undoLabels(deps, profile, changes);
      return withNext(deps, profile, `Undone. ${reopened === 1 ? "That payment is" : `Those ${reopened} payments are`} waiting for a label again.`, () => "");
    }
  }
  if (ASK.test(text.trim())) {
    const asked = await askNextReply(deps, profile);
    if (asked) return asked;
  }
  if (!LIST_QUERY.test(text.trim())) return null;
  const waiting = oldestFirst(await deps.bank.listMessages(profile.profileId, "needs_label"));
  if (waiting.length === 0) return null;
  if (waiting.length === 1) return withNext(deps, profile, "One payment is waiting for a label.", () => "");
  const shown = waiting.slice(0, MAX_SHOWN).map((message, index) => `${index + 1}. ${waitingLine(message, profile)}`);
  const more = waiting.length > MAX_SHOWN ? `\n…and ${waiting.length - MAX_SHOWN} more.` : "";
  return withNext(deps, profile, `${waiting.length} payments are waiting for a label:\n${shown.join("\n")}${more}\n\n${NATURAL_HINT}`, () => "First: ");
}

function purposeWords(text: string): string[] {
  return text.toLowerCase().replace(/[’]/g, "'").match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? [];
}

/** Only explicit purpose words support a focused label; sender/source recognition does not. */
/** Services people pay for monthly, named the way people say them. */
const SUBSCRIPTION_SERVICES = /\b(?:claude|chatgpt|chat gpt|openai|anthropic|netflix|spotify|youtube premium|apple music|apple one|icloud|google one|disney plus|showmax|starlink|prime video|canva|notion|cursor|github copilot)\b/;

function purposeEvidence(text: string, direction: BankMessage["direction"]) {
  const words = purposeWords(text);
  const categories = new Set<string>();
  const spending = new Set<string>();
  for (let index = 0; index < words.length; index++) {
    for (let length = 1; length <= 3 && index + length <= words.length; length++) {
      const phrase = words.slice(index, index + length).join(" ");
      const category = normalizeCategory(phrase, direction === "in" ? "income" : "expense");
      if (category && category !== "Other" && category !== "Misc") categories.add(category);
      const expense = normalizeCategory(phrase, "expense");
      if (expense && expense !== "Misc") spending.add(expense);
    }
  }
  const said = words.join(" ");
  // Paying a well-known service is subscription spending, even when "subscription" isn't said.
  if (direction === "out" && SUBSCRIPTION_SERVICES.test(said)) {
    categories.add("Subscriptions");
    spending.add("Subscriptions");
  }
  // School fees are education, not bank/transaction Fees. If Education is not
  // a supported category yet, ask rather than silently file under Fees.
  if (/\b(?:school fees|tuition|education)\b/.test(said)) {
    categories.delete("Fees");
    spending.delete("Fees");
  }
  const kinds = new Set<Label["kind"]>();
  const semanticWords = new Set<string>();
  if (direction === "in") {
    // Occasion money is a conventional gift purpose, unlike a relative's
    // identity alone. Commercial payments, loans and handled funds do not
    // become gifts merely because an occasion is mentioned.
    const occasionMoney = /\b(?:birthday|christmas|graduation|anniversary|wedding) (?:money|cash)\b/.test(said)
      || /\b(?:money|cash)\b.{0,80}\bfor (?:my|our) (?:birthday|christmas|graduation|anniversary|wedding)\b/.test(said);
    const otherNature = /\b(?:loan|borrowed|repayment|repaid|refund|deposit|sales?|invoice|client|business|work|service|share|contribution|on behalf|someone else's)\b/.test(said);
    const thirdPartyFunds = /\b(?:holding|keeping|handling|passing on|pass through|on behalf of)\b/.test(said)
      || /\b(?:to|for) (?:my |our |the )?(?:grandma|grandmother|grandpa|grandfather|mum|mom|mother|dad|father|sister|brother|aunt|uncle|cousin|friend|wife|husband|daughter|son|child|children|parents?|someone else|them|him|her)\b/.test(said);
    if ((occasionMoney || /\bgifted (?:me|us)\b/.test(said)) && !otherNature && !thirdPartyFunds && !/\b(?:not|never|isn't|wasn't|hasn't|didn't)\b/.test(said)) categories.add("Gift");
    // Receiving rent in one's role as the tenant's payee is rental income;
    // bare "rent" could instead be a contribution, loan or reimbursement.
    const rentalIncome = /\brental income\b/.test(said)
      || /\brent(?: money| payment)? from (?:my |our |the |a )?tenants?\b/.test(said)
      || /\btenants?\b.{0,48}\b(?:paid|paying|sent|transferred)\b.{0,32}\brent\b/.test(said);
    if (rentalIncome && !/\b(?:deposit|refund|returned|loan|borrowed|repayment|repaid|share|contribution|on behalf|not|never|hasn't|didn't)\b/.test(said)) {
      categories.add("Business");
      for (const word of ["rental", "income", "earnings"]) semanticWords.add(word);
    }
  }
  // "He'll pay me back" or "George owes me" is a debt still open, not a repayment happening now.
  const returned = /\b(?:returned (?:the )?money i (?:had )?lent|returned (?:my|the) loan)\b/.test(said);
  const owedLater = !returned && /\b(?:owes? me|(?:will|'ll|going to|gonna|to) pay (?:me )?back|pay me back (?:later|soon|tomorrow|next)|i lent (?:it )?(?:to )?(?:him|her|them|a friend|my friend)|lent (?:it )?to (?:him|her|them|a friend|my friend))\b/.test(said);
  const oweLater = /\b(?:i owe|i'll pay (?:him|her|them) back|i will pay (?:him|her|them) back)\b/.test(said);
  const repayment = !owedLater && !oweLater && /\b(?:repaid|repayment|paying (?:me|them|him|her|you) back|paid (?:me|them|him|her|you) back|pay back|returned (?:the )?money i (?:had )?lent|returned (?:my|the) loan)\b/.test(said);
  if (repayment) kinds.add(direction === "in" ? "repaid" : "paid_back");
  else if (owedLater && direction === "out") kinds.add("lent");
  else if (oweLater && direction === "in") kinds.add("borrowed");
  else if (/\b(?:loan|borrowed|lent me|lent to me)\b/.test(said)) kinds.add(direction === "in" ? "borrowed" : "lent");
  if (/\b(?:my own|own money|between my accounts|between accounts)\b/.test(said)) kinds.add("transfer");
  if (/\b(?:skip|ignore|leave (?:it |this |that )?out|not a payment|same payment)\b/.test(said)) kinds.add("skip");
  if (/\b(?:pass through|someone else's|on behalf of|handling money for)\b/.test(said)) kinds.add("pass_through");
  if (/\b(?:invest|invested|investment)\b/.test(said)) kinds.add("invest");
  if (/\b(?:share|split|contribution|chipping in|chip in)\b/.test(said) && spending.size === 1) kinds.add("chip_in");
  if (categories.has("Refund") && spending.size === 1) kinds.add("refund");
  const purposes = new Set([...categories].map(category => category === "Refund" ? "refund" : `category:${category}`));
  for (const kind of kinds) purposes.add(kind);
  return { words, categories, spending, kinds, purposes, semanticWords };
}

export function explicitExpenseCategory(text: string): string | null {
  const evidence = purposeEvidence(text, "out");
  return !paymentPurposeUnclear(text, "out") && evidence.purposes.size === 1 && evidence.categories.size === 1 ? [...evidence.categories][0] : null;
}

export function paymentPurposeNeedsClassification(text: string, direction: BankMessage["direction"]): boolean {
  return !paymentPurposeUnclear(text, direction) && purposeEvidence(text, direction).purposes.size === 0;
}

/** A tentative single assertion can be clear; questions and competing possibilities cannot. */
export function paymentPurposeUnclear(text: string, direction: BankMessage["direction"]): boolean {
  const said = text.trim().toLowerCase().replace(/[’]/g, "'").replace(/[.!?,;:]+$/g, "").trim();
  if (/^(?:y|yes|yeah|yep|yup|n|no|nope|nah|ok|okay|sure|thanks|thank you|hmm|what|something|stuff|whatever|other|misc(?:ellaneous)?)$/.test(said)) return true;
  if (text.includes("?") || /\b(?:maybe|perhaps|not sure|unsure|no idea|not certain|can't remember|cannot remember|could be|i guess|i (?:do not|don't|dont) know|whether|or)\b/.test(said)) return true;
  if (/\b(?:not|isn't|wasn't|never)\s+(?:a |an |my )?(?:birthday|gift|present|rent|loan|repayment)\b/.test(said)) return true;
  const evidence = purposeEvidence(text, direction);
  return evidence.purposes.size > 1 || /\b(?:probably|i think)\b/.test(said) && evidence.purposes.size !== 1;
}

const PURPOSE_FILLER = new Set(["a", "an", "the", "it", "this", "that", "was", "is", "for", "to", "from", "of", "and", "payment", "money"]);

/** A model may format the person's purpose, but cannot supply a different one or add details. */
export function groundedPaymentLabel(text: string, message: BankMessage, label: Label): boolean {
  if (paymentPurposeUnclear(text, message.direction)) return false;
  const evidence = purposeEvidence(text, message.direction);
  if (evidence.purposes.size !== 1) return false;
  const category = "category" in label ? normalizeCategory(label.category, label.kind === "category" && message.direction === "in" ? "income" : "expense") : null;
  if (label.kind === "category" ? !category || !evidence.categories.has(category) : !evidence.kinds.has(label.kind)) return false;
  if ((label.kind === "refund" || label.kind === "chip_in") && (!category || !evidence.spending.has(category))) return false;
  const details = "description" in label ? label.description : "note" in label ? label.note : "investment" in label ? label.investment : null;
  const own = new Set(evidence.words);
  const sourceWords = new Set(purposeWords(message.counterparty));
  const sameWord = (word: string) => PURPOSE_FILLER.has(word) || own.has(word) || sourceWords.has(word) || evidence.semanticWords.has(word)
    || Boolean(normalizeCategory(word, message.direction === "in" ? "income" : "expense") && evidence.categories.has(normalizeCategory(word, message.direction === "in" ? "income" : "expense")!));
  if (details && !purposeWords(details).every(sameWord)) return false;
  if ("person" in label && label.person && !purposeWords(label.person).every(word => own.has(word) || purposeWords(message.counterparty).includes(word))) return false;
  if (label.kind === "category" && label.forMonth && !text.includes(label.forMonth)) return false;
  if (label.kind === "category" && label.includedFee && (!/\bfee\b/i.test(text) || !text.includes(label.includedFee))) return false;
  return true;
}

/**
 * Whether a model's reading is fit to show the person for confirmation, even
 * though their words didn't name it outright. The model may choose the type of
 * money ("he'll pay me back" is lending, a card top-up is their own money), but
 * it cannot contradict a purpose they named, pick a spending category they
 * didn't mention, or add details and people that appear nowhere.
 */
export function proposableLabel(text: string, message: BankMessage, label: Label, context: string[] = []): boolean {
  if (label.kind === "skip" || paymentPurposeUnclear(text, message.direction)) return false;
  const evidence = purposeEvidence(text, message.direction);
  const category = "category" in label ? normalizeCategory(label.category, label.kind === "category" && message.direction === "in" ? "income" : "expense") : null;
  if (label.kind === "category" || label.kind === "refund" || label.kind === "chip_in") {
    if (!category || !(label.kind === "category" ? evidence.categories : evidence.spending).has(category)) return false;
  } else if (evidence.categories.size > 0 || [...evidence.kinds].some((kind) => kind !== label.kind)) {
    return false;
  }
  const own = new Set([...evidence.words, ...purposeWords(message.counterparty), ...context.flatMap(purposeWords)]);
  const allowed = (word: string) => PURPOSE_FILLER.has(word) || own.has(word) || evidence.semanticWords.has(word)
    || Boolean(category && normalizeCategory(word, message.direction === "in" ? "income" : "expense") === category);
  const details = "description" in label ? label.description : "note" in label ? label.note : "investment" in label ? label.investment : null;
  if (details && !purposeWords(details).every(allowed)) return false;
  if ("person" in label && label.person && !purposeWords(label.person).every((word) => own.has(word))) return false;
  if (label.kind === "category" && (label.forMonth || label.includedFee)) return false;
  return true;
}

/** Files labels the person confirmed, keeping one undo for them all. */
export function proposedLabelApplier(deps: IngestDeps, profile: UserProfile) {
  return async (items: { bankMessageId: string; label: Label }[]): Promise<string> => {
    const lines: string[] = [];
    const changes: LabelChange[] = [];
    for (const item of items) {
      const result = await applyLabel(deps, profile, item.bankMessageId, item.label);
      if (result.ok) changes.push(...result.changes.map((change) => ({ ...change, filedAs: filedAs(item.label) })));
      lines.push(result.text);
    }
    if (changes.length > 0) await deps.bank.saveUndo(profile.profileId, changes);
    return lines.length === 1 ? lines[0] : lines.map((line) => `• ${line}`).join("\n");
  };
}

/**
 * Files what the person said about waiting payments, but only the payments
 * their message really points at, then asks the next one. Returns null when
 * nothing came of it.
 */
export async function applyResolved(deps: IngestDeps, profile: UserProfile, text: string, resolved: ResolvedLabel[], waiting: WaitingPayments): Promise<LabelReply | null> {
  const current = waiting.current;
  const lines: string[] = [];
  const changes: LabelChange[] = [];
  const filed: BankMessage[] = [];
  const picked = resolved.flatMap((answer) => answer.messageIds);
  let dropped = 0;
  for (const answer of resolved) {
    for (const messageId of answer.messageIds) {
      // An earlier label may already have filed this one, e.g. by learning the payee.
      if (changes.some((change) => change.messageId === messageId)) continue;
      const correcting = waiting.recent.find((item) => item.message.id === messageId);
      const message = correcting?.message ?? waiting.all.find((item) => item.id === messageId);
      if (!message || message.ownerId !== profile.profileId) continue;
      if (waiting.exactQuestion && messageId !== current?.id) {
        dropped += 1;
        continue;
      }
      if (waiting.exactQuestion && !groundedPaymentLabel(text, message, answer.label)) {
        dropped += 1;
        continue;
      }
      // A bare reply like "food" answers the question just asked; "no, I mean…" corrects what was just filed.
      const pointer =
        pointsAt(text, message, profile, deps.now) ?? (picked.length === 1 && (messageId === current?.id || correcting) ? "current" : null);
      if (!pointer) {
        dropped += 1;
        continue;
      }
      // A stale model/callback skip must never undo a valid earlier label before
      // the central write guard rejects it. Only an open, positively matched
      // card-hold settlement can use the legacy duplicate-confirmation code.
      if (answer.label.kind === "skip" && (correcting || message.kind !== "hold_settle")) {
        lines.push(message.status === "needs_label" ? PAYMENT_NOTICE_STAYS_PENDING : "I haven't removed or changed that payment. Tell me what needs correcting, or choose Ask something else.");
        continue;
      }
      // A correction puts the payment back first, so the new label replaces the old one.
      if (correcting) await undoLabels(deps, profile, [correcting.change]);
      // Only someone the person named, or the one they were asked about, is remembered for next time.
      const learn = !waiting.exactQuestion && (pointer === "name" || (pointer === "current" && !correcting));
      const result = await applyLabel(deps, profile, messageId, answer.label, { learn });
      if (result.ok) {
        changes.push(...result.changes.map((change) => ({ ...change, filedAs: filedAs(answer.label) })));
        filed.push(message);
        lines.push(correcting ? `Fixed. ${result.text}` : result.text);
      } else if (correcting) {
        lines.push(`${result.text} I've taken off the earlier label, so it's waiting for one again.`);
      } else if (result.text !== "That one is already sorted.") {
        lines.push(result.text);
      }
    }
  }
  // When something the person said went unfiled, a name they used may be someone already sorted.
  if (changes.length === 0 || dropped > 0) lines.push(...(await alreadySorted(deps, profile, text, waiting.all)));
  if (lines.length === 0) return null;
  if (changes.length > 0) await deps.bank.saveUndo(profile.profileId, changes);

  const body = lines.length === 1 ? lines[0] : lines.map((line) => `• ${line}`).join("\n");
  const undo = changes.length > 1 ? `\n\nSorted ${changes.length} payments. Say “undo” if I got any wrong.` : "";
  if (waiting.exactQuestion) return { text: `${body}${undo}`, next: null };
  return withNext(deps, profile, `${body}${undo}`, nextIntro);
}

/**
 * When payments are waiting for a label, handles the person's message if it's
 * about them: "undo", "what are those?", or an answer in their own words
 * worked out by `resolve`. Returns null to let the message go through as a
 * normal chat turn.
 */
export async function answerLabelReply(deps: IngestDeps, profile: UserProfile, text: string, resolve: LabelResolver): Promise<LabelReply | null> {
  const shortcut = await labelShortcut(deps, profile, text);
  if (shortcut) return shortcut;
  const waiting = await waitingPayments(deps, profile);
  if (!waiting) return null;
  let resolved: ResolvedLabel[];
  try {
    resolved = await resolve({ text, waiting, profile });
  } catch (error) {
    logError("label_reply", error);
    return null;
  }
  if (resolved.length === 0) return null;
  return applyResolved(deps, profile, text, resolved, waiting);
}
