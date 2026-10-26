import { IN_CHOICES, OUT_CHOICES, labelQuestion, looksLikeOwner, titleCase, type IngestOutcome, type Label } from "@/lib/bank/ingest";
import type { BankMessage, BankStore } from "@/lib/bank/store";
import type { MessageLog } from "@/lib/accounts/messages";
import type { SupabaseSettings, UserProfile } from "@/lib/config";
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

/** Category buttons under a question. Callback data is `b:<message id>:<code>`. */
export function labelButtons(message: BankMessage, ownerName = ""): InlineButton[][] {
  const choices: readonly string[] = message.direction === "out" ? OUT_CHOICES : IN_CHOICES;
  const buttons = choices.map((category, index) => ({ text: category, callbackData: `b:${message.id}:c${index}` }));
  const rows: InlineButton[][] = [];
  const own: InlineButton = { text: message.direction === "in" ? "My own money" : "My own account", callbackData: `b:${message.id}:t` };
  const ownerLike = looksLikeOwner(message.counterparty, ownerName);
  // When the sender looks like the person, the likeliest answer goes first.
  if (ownerLike) rows.push([own]);
  for (let index = 0; index < buttons.length; index += 4) rows.push(buttons.slice(index, index + 4));
  const extra: InlineButton[] = [];
  if (message.direction === "in" && !ownerLike) extra.push(own);
  extra.push({ text: "Skip", callbackData: `b:${message.id}:s` });
  rows.push(extra);
  return rows;
}

export function parseLabelCallback(data: string): { messageId: string; code: string } | null {
  const match = /^b:([0-9a-f-]{36}):(c\d|t|s)$/i.exec(data);
  return match ? { messageId: match[1].toLowerCase(), code: match[2] } : null;
}

export function labelFromCode(message: BankMessage, code: string): Label | null {
  if (code === "s") return { kind: "skip" };
  if (code === "t") return { kind: "transfer" };
  const choices: readonly string[] = message.direction === "out" ? OUT_CHOICES : IN_CHOICES;
  const category = choices[Number(code.slice(1))];
  return category ? { kind: "category", category } : null;
}

function summaryLine(outcome: IngestOutcome): string | null {
  const message = outcome.message;
  const money = formatAmount(message.amount, message.currency);
  const who = message.counterparty ? titleCase(message.counterparty) : "";
  if (outcome.outcome === "recorded") return `Filed ${money}${who ? ` to ${who}` : ""} under ${outcome.category}.`;
  if (outcome.outcome === "matched") return `${money}${who ? ` to ${who}` : ""} matches something you already logged, so I've linked it.`;
  if (outcome.outcome === "transfer") return `${money} moved between your own accounts. Not counted as income or spending.`;
  if (outcome.outcome === "loan") return `${money} came in from your loan account. That's borrowed money, so I haven't counted it as income.`;
  return null;
}

type Delivery = {
  settings: SupabaseSettings;
  bank: BankStore;
  telegram: TelegramSender | null;
  messages: MessageLog | null;
  profile: UserProfile;
  now: Date;
};

async function send(delivery: Delivery, chatId: number, text: string, buttons?: InlineButton[][]) {
  if (!delivery.telegram) return;
  await delivery.telegram.sendMessage(chatId, text, buttons);
  // Keeps the website's copy of the conversation in step with Telegram.
  await delivery.messages
    ?.append({ ownerId: delivery.profile.profileId, role: "assistant", body: text, channel: "telegram", intent: "bank:notice" })
    .catch((error) => logError("bank_message_log", error));
}

/**
 * Tells the person what happened to newly read messages: one short note for
 * everything filed automatically, and a question with buttons for each payment
 * Alfred couldn't place. Questions wait during quiet hours.
 */
export async function announceOutcomes(delivery: Delivery, outcomes: IngestOutcome[]): Promise<{ asked: number }> {
  const chatId = await telegramChatFor(delivery.settings, delivery.profile.profileId);
  if (!chatId || !delivery.telegram) return { asked: 0 };
  const quiet = isQuietHours(delivery.now, delivery.profile.timezone);

  const notes = outcomes.map(summaryLine).filter((line): line is string => Boolean(line));
  const fees = outcomes.filter((item) => item.feeRecorded);
  if (fees.length > 0) {
    const total = fees.reduce((sum, item) => sum + Number(item.message.fee), 0).toFixed(2);
    notes.push(`Logged ${formatAmount(total, delivery.profile.currency)} in fees under Fees.`);
  }
  if (notes.length > 0 && !quiet) await send(delivery, chatId, notes.join("\n"));

  if (quiet) return { asked: 0 };
  let asked = 0;
  for (const outcome of outcomes.filter((item) => item.outcome === "needs_label")) {
    await askAbout(delivery, chatId, outcome.message);
    asked += 1;
  }
  return { asked };
}

async function askAbout(delivery: Delivery, chatId: number, message: BankMessage) {
  await send(
    delivery,
    chatId,
    labelQuestion(message, delivery.profile.timezone, delivery.profile.preferredName),
    labelButtons(message, delivery.profile.preferredName),
  );
  await delivery.bank.updateMessage(delivery.profile.profileId, message.id, { askedAt: delivery.now.toISOString() });
}

/** Asks about anything held overnight or never asked. Runs from the daily cron. */
export async function askHeldQuestions(delivery: Omit<Delivery, "profile">, profiles: UserProfile[]): Promise<number> {
  let asked = 0;
  for (const profile of profiles) {
    if (isQuietHours(delivery.now, profile.timezone)) continue;
    const chatId = await telegramChatFor(delivery.settings, profile.profileId);
    if (!chatId) continue;
    const held = (await delivery.bank.listMessages(profile.profileId, "needs_label")).filter((item) => !item.askedAt).slice(0, 10);
    for (const message of held.reverse()) {
      await askAbout({ ...delivery, profile }, chatId, message);
      asked += 1;
    }
  }
  return asked;
}
