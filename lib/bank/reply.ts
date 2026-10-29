import { z } from "zod";

import { chatCompletion } from "@/lib/ai/deepseek";
import { applyLabel, titleCase, undoLabels, type IngestDeps, type Label } from "@/lib/bank/ingest";
import { NATURAL_HINT, questionFor } from "@/lib/bank/notify";
import { payeeKey } from "@/lib/bank/parse";
import { classifyPayee } from "@/lib/bank/payees";
import type { BankMessage, LabelChange } from "@/lib/bank/store";
import type { DeepSeekSettings, UserProfile } from "@/lib/config";
import { categoryList, EXPENSE_CATEGORIES, INCOME_CATEGORIES } from "@/lib/finance/categories";
import { zonedYmd } from "@/lib/finance/dates";
import { owedBy } from "@/lib/finance/loans";
import { formatAmount } from "@/lib/finance/money";
import { logError } from "@/lib/log";
import type { InlineButton } from "@/lib/telegram/client";

/** How long "undo" reverses labels rather than meaning something else. */
const UNDO_WINDOW_MS = 30 * 60_000;
/** How many waiting payments the model sees at once, oldest first. */
const MAX_LISTED = 40;
/**
 * Matching many payments to a loose sentence needs the stronger model; the
 * small one guesses, e.g. filing every unnamed payment as "office snacks".
 */
const LABEL_MODEL = "deepseek-v4-pro";

/** One instruction from the person: these payments get this label. */
export type ResolvedLabel = { messageIds: string[]; label: Label };

export type LabelResolver = (input: {
  text: string;
  waiting: BankMessage[];
  current: BankMessage | null;
  profile: UserProfile;
  owed: Map<string, string>;
  today: string;
}) => Promise<ResolvedLabel[]>;

const answerSchema = z.object({
  answers: z
    .array(
      z.object({
        items: z.array(z.number().int()).max(MAX_LISTED),
        action: z.enum(["category", "own_transfer", "lent", "repaid", "skip"]),
        category: z.string().max(40).nullable().optional(),
        description: z.string().max(200).nullable().optional(),
        person: z.string().max(120).nullable().optional(),
      }),
    )
    .max(20),
});

function listLine(message: BankMessage, index: number, profile: UserProfile, owed: Map<string, string>): string {
  const money = formatAmount(message.amount, message.currency);
  const when = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: profile.timezone }).format(
    new Date(message.occurredAt),
  );
  const payee = classifyPayee(message.counterparty);
  const name = message.counterparty ? titleCase(message.counterparty) : message.source === "gcb" ? "GCB card" : "unknown";
  const who =
    payee.kind === "channel" ? `${name} (sent to ${payee.channel}; the recipient isn't named)` : name;
  const debt = owed.get(message.id);
  return `${index + 1}. ${message.direction === "out" ? "OUT" : "IN"} ${money} ${message.direction === "out" ? "to" : "from"} ${who} · ${when}${debt ? ` · this person owes them ${debt}` : ""}`;
}

/** Asks the model which waiting payments a message is about and what each one was. */
export function createLabelResolver(settings: DeepSeekSettings, fetchImpl: typeof fetch = fetch): LabelResolver {
  return async ({ text, waiting, current, profile, owed, today }) => {
    const listed = waiting.slice(0, MAX_LISTED);
    const currentNumber = current ? listed.findIndex((item) => item.id === current.id) + 1 : 0;
    const system = [
      "You help a personal finance assistant file payments from the user's bank and mobile money texts. Some are waiting for the user to say what they were.",
      "Decide which waiting payments the user's message is about, and what each one was. Reply with JSON only:",
      '{"answers":[{"items":[1,2],"action":"category","category":"Food","description":"Office snacks","person":null}]}',
      "Actions:",
      "- category: spending or income. category must come from the lists below; description is a short label in the user's words, or null.",
      "- lent: money the user lent out (a loan to someone, they'll pay it back). Outgoing only. person is who borrowed it: the payee, or a name the user gives.",
      "- repaid: someone paying back money they borrowed. Incoming only. person is who paid back, or null for the sender.",
      "- own_transfer: the user's own money moving between their own accounts.",
      "- skip: a test, a mistake, a reversal, or something not to count.",
      "Matching:",
      "- Include a payment only when the message clearly points at it: by name (nicknames and first names count, like Debby for Deborah), amount, date, network, or words like all, every, both, the rest.",
      "- \"All money to X\" or \"everything to X\" covers every listed payment to X, and no one else's.",
      "- If the user names someone who isn't in the list, they're already sorted: leave that instruction out. Never move it onto other payments.",
      currentNumber > 0
        ? `- A short reply that points at nothing, like \"food\" or \"lunch with Kofi\", answers payment ${currentNumber}, which the user was just asked about.`
        : "- A short reply that points at nothing answers nothing.",
      "- Several instructions in one message become several answers.",
      "- If the message isn't about these payments at all (a question, a new expense, small talk), reply {\"answers\":[]}.",
      `Spending categories: ${categoryList("expense").join(", ")}.`,
      `Income categories: ${categoryList("income").join(", ")}.`,
      `Today is ${today}.`,
      "Waiting payments:",
      ...listed.map((message, index) => listLine(message, index, profile, owed)),
    ].join("\n");
    const content = await chatCompletion(
      { ...settings, model: LABEL_MODEL },
      [
        { role: "system", content: system },
        { role: "user", content: text },
      ],
      { temperature: 0, maxTokens: 600, timeoutMs: 25_000 },
      fetchImpl,
    );
    const parsed = answerSchema.safeParse(JSON.parse(content));
    if (!parsed.success) return [];
    return parsed.data.answers
      .map((answer): ResolvedLabel | null => {
        const messageIds = [...new Set(answer.items)].map((number) => listed[number - 1]?.id).filter((id): id is string => Boolean(id));
        if (messageIds.length === 0) return null;
        if (answer.action === "skip") return { messageIds, label: { kind: "skip" } };
        if (answer.action === "own_transfer") return { messageIds, label: { kind: "transfer" } };
        if (answer.action === "lent") return { messageIds, label: { kind: "lent", person: answer.person ?? null, note: answer.description ?? null } };
        if (answer.action === "repaid") return { messageIds, label: { kind: "repaid", person: answer.person ?? null } };
        if (!answer.category) return null;
        return { messageIds, label: { kind: "category", category: answer.category, description: answer.description ?? null } };
      })
      .filter((item): item is ResolvedLabel => item !== null);
  };
}

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

/** People the message names who were already sorted, so the person knows why nothing changed for them. */
async function alreadySorted(deps: IngestDeps, profile: UserProfile, text: string, waiting: BankMessage[]): Promise<string[]> {
  const said = words(text);
  const waitingKeys = new Set(waiting.map((item) => payeeKey(item.counterparty)));
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const message of await deps.bank.listMessages(profile.profileId)) {
    const key = payeeKey(message.counterparty);
    if (message.status === "needs_label" || !key || seen.has(key) || waitingKeys.has(key) || !namesIt(said, message.counterparty)) continue;
    seen.add(key);
    const rule = await deps.bank.getRule(profile.profileId, key);
    const filed = rule ? `: I file them under ${rule.category}${rule.description ? ` · ${rule.description}` : ""}` : "";
    notes.push(`${titleCase(message.counterparty)} is already sorted${filed}. Tell me if that should change.`);
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
  const question = await questionFor(deps.loans, profile, next);
  return { text: `${text}\n\n${intro(remaining)}${question.text}`, next, buttons: question.buttons };
}

const nextIntro = (remaining: number) => (remaining > 1 ? `Next (${remaining - 1} more after this): ` : "Last one: ");

/**
 * When payments are waiting for a label, handles the person's message if it's
 * about them: answers in their own words (one or many at once), "what are
 * those?", or "undo". Returns null to let the message go through as a normal
 * chat turn.
 */
export async function answerLabelReply(deps: IngestDeps, profile: UserProfile, text: string, resolve: LabelResolver): Promise<LabelReply | null> {
  if (UNDO.test(text)) {
    const changes = await deps.bank.takeUndo(profile.profileId, new Date(deps.now.getTime() - UNDO_WINDOW_MS));
    if (changes) {
      const reopened = await undoLabels(deps, profile, changes);
      return withNext(deps, profile, `Undone. ${reopened === 1 ? "That payment is" : `Those ${reopened} payments are`} waiting for a label again.`, () => "");
    }
  }

  const waiting = oldestFirst(await deps.bank.listMessages(profile.profileId, "needs_label"));
  if (waiting.length === 0) return null;

  if (LIST_QUERY.test(text.trim())) {
    if (waiting.length === 1) return withNext(deps, profile, "One payment is waiting for a label.", () => "");
    const shown = waiting.slice(0, MAX_SHOWN).map((message, index) => `${index + 1}. ${waitingLine(message, profile)}`);
    const more = waiting.length > MAX_SHOWN ? `\n…and ${waiting.length - MAX_SHOWN} more.` : "";
    return withNext(deps, profile, `${waiting.length} payments are waiting for a label:\n${shown.join("\n")}${more}\n\n${NATURAL_HINT}`, () => "First: ");
  }

  // The most recently asked question is the one a bare reply most likely answers.
  const current = [...waiting].filter((item) => item.askedAt).sort((left, right) => (right.askedAt ?? "").localeCompare(left.askedAt ?? ""))[0] ?? null;
  const owed = new Map<string, string>();
  if (deps.loans) {
    for (const message of waiting.filter((item) => item.direction === "in").slice(0, MAX_LISTED)) {
      const debt = await owedBy(deps.loans, profile.profileId, message.counterparty);
      if (debt) owed.set(message.id, formatAmount(debt.owed, debt.currency));
    }
  }

  let resolved: ResolvedLabel[];
  try {
    resolved = await resolve({ text, waiting, current, profile, owed, today: zonedYmd(deps.now, profile.timezone) });
  } catch (error) {
    logError("label_reply", error);
    return null;
  }
  if (resolved.length === 0) return null;

  const lines: string[] = [];
  const changes: LabelChange[] = [];
  const picked = resolved.flatMap((answer) => answer.messageIds);
  let dropped = 0;
  for (const answer of resolved) {
    for (const messageId of answer.messageIds) {
      // An earlier label may already have filed this one, e.g. by learning the payee.
      if (changes.some((change) => change.messageId === messageId)) continue;
      const message = waiting.find((item) => item.id === messageId);
      if (!message) continue;
      // A bare reply like "food" answers the question just asked.
      const pointer = pointsAt(text, message, profile, deps.now) ?? (picked.length === 1 && messageId === current?.id ? "current" : null);
      if (!pointer) {
        dropped += 1;
        continue;
      }
      // Only someone the person named, or the one they were asked about, is remembered for next time.
      const learn = pointer === "name" || pointer === "current";
      const result = await applyLabel(deps, profile, messageId, answer.label, { learn });
      if (result.ok) changes.push(...result.changes);
      if (result.ok || result.text !== "That one is already sorted.") lines.push(result.text);
    }
  }
  if (lines.length > 0 || dropped > 0) lines.push(...(await alreadySorted(deps, profile, text, waiting)));
  if (lines.length === 0) return null;
  if (changes.length > 0) await deps.bank.saveUndo(profile.profileId, changes);

  const body = lines.length === 1 ? lines[0] : lines.map((line) => `• ${line}`).join("\n");
  const undo = changes.length > 1 ? `\n\nSorted ${changes.length} payments. Say “undo” if I got any wrong.` : "";
  return withNext(deps, profile, `${body}${undo}`, nextIntro);
}
