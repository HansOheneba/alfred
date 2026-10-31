import { applyLabel, titleCase, undoLabels, type IngestDeps, type Label } from "@/lib/bank/ingest";
import { NATURAL_HINT, questionFor, reviewRow } from "@/lib/bank/notify";
import { accountOf, payeeKey, purposeOf } from "@/lib/bank/parse";
import { classifyPayee } from "@/lib/bank/payees";
import type { BankMessage, LabelChange } from "@/lib/bank/store";
import type { UserProfile } from "@/lib/config";
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from "@/lib/finance/categories";
import { zonedYmd } from "@/lib/finance/dates";
import { owedBy, oweTo } from "@/lib/finance/loans";
import type { LabelAnswer } from "@/lib/finance/schemas";
import { formatAmount } from "@/lib/finance/money";
import { logError } from "@/lib/log";
import type { InlineButton } from "@/lib/telegram/client";

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
};

/** Works out which payments a message is about and what each was, e.g. from the main conversation's answer. */
export type LabelResolver = (input: { text: string; waiting: WaitingPayments; profile: UserProfile }) => Promise<ResolvedLabel[]>;

function listLine(message: BankMessage, index: number, profile: UserProfile, debts: Map<string, string>, filedAs?: string): string {
  const money = formatAmount(message.amount, message.currency);
  const when = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: profile.timezone }).format(
    new Date(message.occurredAt),
  );
  const payee = classifyPayee(message.counterparty);
  const name = message.counterparty ? titleCase(message.counterparty) : message.source === "gcb" ? "GCB card" : "unknown";
  const who =
    payee.kind === "channel" ? `${name} (sent to ${payee.channel}; the recipient isn't named)` : name;
  const debt = debts.get(message.id);
  const purpose = purposeOf(message);
  const owing = debt ? (message.direction === "in" ? ` · this person owes the user ${debt}` : ` · the user owes this person ${debt}`) : "";
  const filed = filedAs ? ` · JUST FILED as ${filedAs}` : "";
  const account = accountOf(message.raw);
  return `${index + 1}. ${message.direction === "out" ? "OUT" : "IN"} ${money} ${message.direction === "out" ? "to" : "from"} ${who} · ${when}${account ? ` · account ending ${account}` : ""}${purpose ? ` · marked "${purpose}"` : ""}${owing}${filed}`;
}

/** What a label filed a payment as, in a few words, e.g. "Transport · Okada" or "paying you back". */
export function filedAs(label: Label): string {
  if (label.kind === "category") return label.description ? `${label.category} · ${label.description}` : label.category;
  if (label.kind === "chip_in") return `${label.person ? `${label.person}'s` : "their"} share of ${label.category}`;
  if (label.kind === "transfer") return "the user's own money";
  if (label.kind === "skip") return "left out";
  if (label.kind === "lent") return "money the user lent";
  if (label.kind === "repaid") return "paying the user back";
  if (label.kind === "borrowed") return "money lent to the user";
  return "the user paying back a debt";
}

/**
 * What's waiting for a label, plus what the last label just filed, numbered
 * for the model, or null when there's neither.
 */
export async function waitingPayments(deps: IngestDeps, profile: UserProfile): Promise<WaitingPayments | null> {
  const all = oldestFirst(await deps.bank.listMessages(profile.profileId, "needs_label"));
  const recent = await justFiled(deps, profile);
  if (all.length === 0 && recent.length === 0) return null;
  const listed = [...all.slice(0, MAX_LISTED), ...recent.map((item) => item.message)];
  // The most recently asked question is the one a bare reply most likely answers.
  const current = [...all].filter((item) => item.askedAt).sort((left, right) => (right.askedAt ?? "").localeCompare(left.askedAt ?? ""))[0] ?? null;
  const debts = new Map<string, string>();
  if (deps.loans) {
    for (const message of listed) {
      const debt = await (message.direction === "in" ? owedBy : oweTo)(deps.loans, profile.profileId, message.counterparty);
      if (debt) debts.set(message.id, formatAmount(message.direction === "in" ? debt.owed : debt.owe, debt.currency));
    }
  }
  return {
    all,
    recent,
    listed,
    lines: listed.map((message, index) => listLine(message, index, profile, debts, recent.find((item) => item.message.id === message.id)?.change.filedAs)),
    current,
    currentNumber: current ? listed.findIndex((item) => item.id === current.id) + 1 : 0,
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
      if (answer.action === "lent") return { messageIds, label: { kind: "lent", person: answer.person ?? null, note: answer.description ?? null } };
      if (answer.action === "repaid") return { messageIds, label: { kind: "repaid", person: answer.person ?? null } };
      if (answer.action === "borrowed") return { messageIds, label: { kind: "borrowed", person: answer.person ?? null, note: answer.description ?? null } };
      if (answer.action === "paid_back") return { messageIds, label: { kind: "paid_back", person: answer.person ?? null } };
      if (!answer.category) return null;
      if (answer.action === "chip_in") return { messageIds, label: { kind: "chip_in", category: answer.category, description: answer.description ?? null, person: answer.person ?? null } };
      return { messageIds, label: { kind: "category", category: answer.category, description: answer.description ?? null } };
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
function waitingLine(message: BankMessage, profile: UserProfile): string {
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
  const question = await questionFor(deps.loans, profile, next, deps.people);
  return { text: `${text}\n\n${intro(remaining)}${question.text}`, next, buttons: [...question.buttons, ...reviewRow(remaining)] };
}

const nextIntro = (remaining: number) => (remaining > 1 ? `Next (${remaining - 1} more after this): ` : "Last one: ");

/** "undo" and "what are those?" while payments are waiting: answered without the model. */
export async function labelShortcut(deps: IngestDeps, profile: UserProfile, text: string): Promise<LabelReply | null> {
  if (UNDO.test(text)) {
    const changes = await deps.bank.takeUndo(profile.profileId, new Date(deps.now.getTime() - UNDO_WINDOW_MS));
    if (changes) {
      const reopened = await undoLabels(deps, profile, changes);
      return withNext(deps, profile, `Undone. ${reopened === 1 ? "That payment is" : `Those ${reopened} payments are`} waiting for a label again.`, () => "");
    }
  }
  if (ASK.test(text.trim())) {
    const count = (await deps.bank.listMessages(profile.profileId, "needs_label")).length;
    if (count > 0) return withNext(deps, profile, count === 1 ? "One payment is waiting for a label." : `${count} payments are waiting for a label.`, () => "First: ");
  }
  if (!LIST_QUERY.test(text.trim())) return null;
  const waiting = oldestFirst(await deps.bank.listMessages(profile.profileId, "needs_label"));
  if (waiting.length === 0) return null;
  if (waiting.length === 1) return withNext(deps, profile, "One payment is waiting for a label.", () => "");
  const shown = waiting.slice(0, MAX_SHOWN).map((message, index) => `${index + 1}. ${waitingLine(message, profile)}`);
  const more = waiting.length > MAX_SHOWN ? `\n…and ${waiting.length - MAX_SHOWN} more.` : "";
  return withNext(deps, profile, `${waiting.length} payments are waiting for a label:\n${shown.join("\n")}${more}\n\n${NATURAL_HINT}`, () => "First: ");
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
      if (!message) continue;
      // A bare reply like "food" answers the question just asked; "no, I mean…" corrects what was just filed.
      const pointer =
        pointsAt(text, message, profile, deps.now) ?? (picked.length === 1 && (messageId === current?.id || correcting) ? "current" : null);
      if (!pointer) {
        dropped += 1;
        continue;
      }
      // A correction puts the payment back first, so the new label replaces the old one.
      if (correcting) await undoLabels(deps, profile, [correcting.change]);
      // Only someone the person named, or the one they were asked about, is remembered for next time.
      const learn = pointer === "name" || (pointer === "current" && !correcting);
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
