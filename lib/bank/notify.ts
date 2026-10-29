import { IN_CHOICES, OUT_CHOICES, labelQuestion, learnable, looksLikeOwner, titleCase, type IngestOutcome, type Label } from "@/lib/bank/ingest";
import { classifyPayee } from "@/lib/bank/payees";
import type { BankMessage, BankStore } from "@/lib/bank/store";
import type { MessageLog } from "@/lib/accounts/messages";
import { DASHBOARD_URL, type SupabaseSettings, type UserProfile } from "@/lib/config";
import { findPerson, owedBy, oweTo, type LoanStore } from "@/lib/finance/loans";
import type { PeopleStore } from "@/lib/people/store";
import { formatAmount } from "@/lib/finance/money";
import { logError } from "@/lib/log";
import { query } from "@/lib/supabase/connection";
import type { InlineButton, TelegramSender } from "@/lib/telegram/client";

/** Alfred holds questions overnight, 10pm to 7am in the person's own timezone. */
export function isQuietHours(now: Date, timeZone: string): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone }).format(now));
  return hour >= 22 || hour < 7;
}

export async function telegramChatFor(settings: SupabaseSettings, ownerId: string): Promise<number | null> {
  const rows = await query<{ chat_id: string | null }>(
    settings,
    "select chat_id::text from public.telegram_accounts where owner_id = $1::uuid and locked_at is not null",
    [ownerId],
  );
  const chat = rows[0]?.chat_id;
  return chat ? Number(chat) : null;
}

function summaryLine(outcome: IngestOutcome): string | null {
  const message = outcome.message;
  const money = formatAmount(message.amount, message.currency);
  const who = message.counterparty ? titleCase(message.counterparty) : "";
  if (outcome.outcome === "recorded" && outcome.chipIn) return `Counted ${money}${who ? ` from ${who}` : ""} as their share of ${outcome.category}.`;
  if (outcome.outcome === "recorded") return `Filed ${money}${who ? ` to ${who}` : ""} under ${outcome.category}.`;
  if (outcome.outcome === "matched") return `${money}${who ? ` to ${who}` : ""} matches something you already logged, so I've linked it.`;
  if (outcome.outcome === "transfer") return `${money} moved between your own accounts. Not counted as income or spending.`;
  if (outcome.outcome === "loan") return `${money} came in from your loan account. That's borrowed money, so I haven't counted it as income.`;
  if (outcome.outcome === "skipped") return `Left out ${money}${who ? ` ${message.direction === "out" ? "to" : "from"} ${who}` : ""}: it looks like a card check or test send.`;
  return null;
}

type Delivery = {
  settings: SupabaseSettings;
  bank: BankStore;
  telegram: TelegramSender | null;
  messages: MessageLog | null;
  profile: UserProfile;
  now: Date;
  loans?: LoanStore;
  people?: PeopleStore | null;
};

async function send(delivery: Delivery, chatId: number, text: string, buttons?: InlineButton[][]) {
  if (!delivery.telegram) return;
  await delivery.telegram.sendMessage(chatId, text, buttons);
  // Keeps the website's copy of the conversation in step with Telegram.
  await delivery.messages
    ?.append({ ownerId: delivery.profile.profileId, role: "assistant", body: text, channel: "telegram", intent: "bank:notice" })
    .catch((error) => logError("bank_message_log", error));
}

/** Category buttons under a question. Callback data is `b:<message id>:<code>`. */
export function labelButtons(message: BankMessage, ownerName = "", options: { settling?: boolean; lending?: boolean } = {}): InlineButton[][] {
  const choices: readonly string[] = message.direction === "out" ? OUT_CHOICES : IN_CHOICES;
  const buttons = choices.map((category, index) => ({ text: category, callbackData: `b:${message.id}:c${index}` }));
  const rows: InlineButton[][] = [];
  const own: InlineButton = { text: message.direction === "in" ? "My own money" : "My own account", callbackData: `b:${message.id}:t` };
  const ownerLike = looksLikeOwner(message.counterparty, ownerName);
  // When the sender looks like the person, or a debt is open with them, the likeliest answer goes first.
  if (options.settling) {
    rows.push([message.direction === "in" ? { text: "Yes, paying me back", callbackData: `b:${message.id}:r` } : { text: "Yes, paying them back", callbackData: `b:${message.id}:p` }]);
  }
  if (ownerLike) rows.push([own]);
  for (let index = 0; index < buttons.length; index += 4) rows.push(buttons.slice(index, index + 4));
  const extra: InlineButton[] = [];
  if (message.direction === "in" && !ownerLike) extra.push(own);
  // Lending and borrowing need a name, so they're offered only when the message names a person.
  if (options.lending && !ownerLike && learnable(message.counterparty) && classifyPayee(message.counterparty).kind === "person") {
    extra.push(message.direction === "out" ? { text: "I lent it", callbackData: `b:${message.id}:l` } : { text: "Lent to me", callbackData: `b:${message.id}:b` });
  }
  extra.push({ text: "Skip", callbackData: `b:${message.id}:s` });
  rows.push(extra);
  return rows;
}

/** A row with a link to the review page, for when several payments are waiting. */
export function reviewRow(waiting: number): InlineButton[][] {
  return waiting > 1 ? [[{ text: `Review all ${waiting} on the web`, url: `${DASHBOARD_URL}/review` }]] : [];
}

export function parseLabelCallback(data: string): { messageId: string; code: string } | null {
  const match = /^b:([0-9a-f-]{36}):(c\d|t|s|r|l|b|p)$/i.exec(data);
  return match ? { messageId: match[1].toLowerCase(), code: match[2] } : null;
}

export function labelFromCode(message: BankMessage, code: string): Label | null {
  if (code === "s") return { kind: "skip" };
  if (code === "t") return { kind: "transfer" };
  if (code === "r") return { kind: "repaid" };
  if (code === "l") return { kind: "lent" };
  if (code === "b") return { kind: "borrowed" };
  if (code === "p") return { kind: "paid_back" };
  const choices: readonly string[] = message.direction === "out" ? OUT_CHOICES : IN_CHOICES;
  const category = choices[Number(code.slice(1))];
  return category ? { kind: "category", category } : null;
}

/** What a button press reads as in the conversation. */
export function labelChoiceText(label: Label): string {
  if (label.kind === "category") return label.category;
  if (label.kind === "transfer") return "My own money";
  if (label.kind === "repaid") return "Paying me back";
  if (label.kind === "lent") return "I lent it";
  if (label.kind === "borrowed") return "Lent to me";
  if (label.kind === "paid_back") return "Paying them back";
  return "Skip";
}

export type Question = { text: string; buttons: InlineButton[][] };

/**
 * The question and buttons for one waiting payment. Money from someone who
 * owes the person, or to someone the person owes, is asked about as a
 * possible repayment.
 */
export async function questionFor(loans: LoanStore | undefined, profile: UserProfile, message: BankMessage, people?: PeopleStore | null): Promise<Question> {
  const debt =
    loans && learnable(message.counterparty) ? await (message.direction === "in" ? owedBy : oweTo)(loans, profile.profileId, message.counterparty) : null;
  return {
    text: `${labelQuestion(message, profile.timezone, profile.preferredName, debt)}${debt ? "" : await whoTheyAre(people, profile, message)}`,
    buttons: labelButtons(message, profile.preferredName, { settling: Boolean(debt), lending: Boolean(loans) }),
  };
}

/**
 * What the person told Alfred about the payee, or, for someone new, a nudge
 * to say who they are, since that's what makes the next payment easy.
 */
async function whoTheyAre(people: PeopleStore | null | undefined, profile: UserProfile, message: BankMessage): Promise<string> {
  if (!people || !learnable(message.counterparty) || classifyPayee(message.counterparty).kind !== "person" || looksLikeOwner(message.counterparty, profile.preferredName)) return "";
  const name = titleCase(message.counterparty);
  const known = findPerson(await people.list(profile.profileId), name);
  return known ? `\n(You told me: ${known.note})` : `\nIf they're someone regular, tell me who ${name} is and I'll remember.`;
}

/** How to answer several at once, shown when more than one payment is waiting. */
export const NATURAL_HINT =
  "You can answer in your own words, even several at once, like “everything to Adisah was office snacks” or “the 400 to Deborah was a loan”.";

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One line per outcome when there are a few, or a single tally when there are many. */
export function summarize(outcomes: IngestOutcome[], currency: string): string[] {
  const fees = outcomes.filter((item) => item.feeRecorded).reduce((sum, item) => sum + Math.round(Number(item.message.fee) * 100), 0);
  const feeLine = fees > 0 ? `${formatAmount((fees / 100).toFixed(2), currency)} in fees went under Fees.` : null;
  const settled = outcomes.filter((item) => item.outcome !== "needs_label");
  if (outcomes.length <= 3) {
    const lines = settled.map(summaryLine).filter((line): line is string => Boolean(line));
    return feeLine ? [...lines, feeLine] : lines;
  }
  const count = (kind: IngestOutcome["outcome"]) => outcomes.filter((item) => item.outcome === kind).length;
  const filed = outcomes.filter((item) => item.outcome === "recorded");
  const categories = [...new Set(filed.map((item) => item.category).filter(Boolean))].join(", ");
  const parts = [
    filed.length ? `${filed.length} filed automatically${categories ? ` (${categories})` : ""}` : "",
    count("matched") ? `${count("matched")} matched something you'd logged` : "",
    count("transfer") ? `${plural(count("transfer"), "was", "were")} your own money moving` : "",
    count("loan") ? `${plural(count("loan"), "loan deposit")}` : "",
    count("skipped") ? `${plural(count("skipped"), "tiny test charge")} left out` : "",
    count("needs_label") ? `${count("needs_label")} need${count("needs_label") === 1 ? "s" : ""} a label` : "",
  ].filter(Boolean);
  const lines = [`I read ${plural(outcomes.length, "new payment")}: ${parts.join(", ")}.`];
  return feeLine ? [...lines, feeLine] : lines;
}

/**
 * Tells the person what happened to newly read messages in one message: a
 * summary, then the first payment that needs a label, with buttons. The rest
 * are asked one at a time as they answer. Questions wait during quiet hours.
 */
export async function announceOutcomes(delivery: Delivery, outcomes: IngestOutcome[]): Promise<{ asked: number }> {
  const chatId = await telegramChatFor(delivery.settings, delivery.profile.profileId);
  if (!chatId || !delivery.telegram || outcomes.length === 0) return { asked: 0 };
  const quiet = isQuietHours(delivery.now, delivery.profile.timezone);
  const lines = summarize(outcomes, delivery.profile.currency);
  const waiting = outcomes.filter((item) => item.outcome === "needs_label").length;

  if (quiet || waiting === 0) {
    if (quiet && waiting > 0) lines.push(`I'll ask about the ${waiting === 1 ? "one" : waiting} that need${waiting === 1 ? "s" : ""} a label in the morning.`);
    if (lines.length > 0) await send(delivery, chatId, lines.join("\n"));
    return { asked: 0 };
  }
  const next = await askNextWaiting(delivery);
  if (!next) {
    if (lines.length > 0) await send(delivery, chatId, lines.join("\n"));
    return { asked: 0 };
  }
  const question = await questionFor(delivery.loans, delivery.profile, next, delivery.people);
  const total = (await delivery.bank.listMessages(delivery.profile.profileId, "needs_label")).length;
  const intro = total > 1 ? [`${NATURAL_HINT}`, "", `First of ${total}:`] : [];
  await send(delivery, chatId, [...lines, ...(lines.length ? [""] : []), ...intro, question.text].join("\n"), [...question.buttons, ...reviewRow(total)]);
  return { asked: 1 };
}

/** The oldest payment still waiting, marked as the one being asked about now. */
async function askNextWaiting(delivery: Pick<Delivery, "bank" | "profile" | "now">): Promise<BankMessage | null> {
  const waiting = await delivery.bank.listMessages(delivery.profile.profileId, "needs_label");
  const next = [...waiting].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))[0] ?? null;
  if (next) await delivery.bank.updateMessage(delivery.profile.profileId, next.id, { askedAt: delivery.now.toISOString() });
  return next;
}

/** Morning nudge about payments held overnight or never asked: one message per person. Runs from the daily cron. */
export async function askHeldQuestions(delivery: Omit<Delivery, "profile">, profiles: UserProfile[]): Promise<number> {
  let asked = 0;
  for (const profile of profiles) {
    if (isQuietHours(delivery.now, profile.timezone)) continue;
    const chatId = await telegramChatFor(delivery.settings, profile.profileId);
    if (!chatId) continue;
    const waiting = await delivery.bank.listMessages(profile.profileId, "needs_label");
    if (!waiting.some((item) => !item.askedAt)) continue;
    const next = await askNextWaiting({ ...delivery, profile });
    if (!next) continue;
    const question = await questionFor(delivery.loans, profile, next, delivery.people);
    const intro = waiting.length > 1 ? [`${plural(waiting.length, "payment")} still need a label. ${NATURAL_HINT}`, "", "First:"] : [];
    await send({ ...delivery, profile }, chatId, [...intro, question.text].join("\n"), [...question.buttons, ...reviewRow(waiting.length)]);
    asked += 1;
  }
  return asked;
}
