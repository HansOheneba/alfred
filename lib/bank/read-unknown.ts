import { createHash } from "node:crypto";

import { z } from "zod";

import { chatCompletion } from "@/lib/ai/deepseek";
import { cardMerchant, type ParsedBankMessage } from "@/lib/bank/parse";
import type { DeepSeekSettings } from "@/lib/config";
import { canonicalizeAmount } from "@/lib/finance/money";
import { logError } from "@/lib/log";

/**
 * Reads a bank text Alfred has no rules for, so a new bank works without
 * anyone writing rules first. The model says what the text means; the server
 * then checks every figure against the text itself, so nothing it invents can
 * get into the books: an amount, fee or balance must be written in the text,
 * and a payee or transaction id must appear in it word for word.
 */
export type UnknownTextReader = (text: string, options: { sender: string | null; now: Date }) => Promise<ParsedBankMessage[]>;

/** Worth asking the model about: names cedis and has a figure. Any sender: the model tells alerts from people's messages. */
export function looksLikeMoney(text: string): boolean {
  return /\bGH(?:S|₵|¢)|\bcedis?\b/i.test(text) && /\d/.test(text) && text.length <= 1200;
}

const PROMPT = `You read text messages for a person in Ghana and pick out the ones that record money moving in their own accounts.
Texts can come from banks, mobile money providers and merchants, but also from people. The sender is a name like "Ecobank" or a phone number.

For each separate message in the text, say whether it is an automated alert from a bank, mobile money provider or merchant system (from_provider), and whether it records money actually moving into or out of the person's account (moves_money).

A message a person wrote is never from_provider and never moves_money, even when it talks about money ("I've sent you GHS 50", "pay me back the 200", "can you send 100 cedis"): the provider's own alert is what counts.
Not money moving: declined or failed payments, one-time codes, balance-only notices, loan or product offers, promotions, reminders.
A card payment the bank has put on hold ("earmarked", "reserved", "authorised", "pending") IS money moving: set on_hold to true.

Copy figures exactly as written in the text. Use the Ghana cedi (GHS) figure; when a foreign amount has a cedi equivalent, use the cedi one.
counterparty is who the money went to or came from, copied from the text, without account or phone numbers. Use null when the text doesn't say.
transaction_id is the provider's reference number for the payment, copied from the text, or null.
bank is the bank or provider's short name, like "Ecobank" or "Fidelity", or null. Mobile money alerts ("Cash In", "Cash Out", "MoMo", "Payment received for") are "MoMo" for MTN, "Telecel Cash" or "AirtelTigo Money".

Reply with JSON only: {"alerts":[{"from_provider":true,"moves_money":true,"direction":"in"|"out","amount":"100.00","fee":"1.00"|null,"balance":"1947.22"|null,"counterparty":"KOFI MENSAH"|null,"transaction_id":"123456"|null,"on_hold":false,"bank":"Absa"|null}]}`;

const answerSchema = z.object({
  alerts: z
    .array(
      z.object({
        from_provider: z.boolean().nullish(),
        moves_money: z.boolean(),
        direction: z.enum(["in", "out"]).nullish(),
        amount: z.string().nullish(),
        fee: z.string().nullish(),
        balance: z.string().nullish(),
        counterparty: z.string().nullish(),
        transaction_id: z.string().nullish(),
        on_hold: z.boolean().nullish(),
        bank: z.string().nullish(),
      }),
    )
    .max(5),
});

export type ModelAlert = z.infer<typeof answerSchema>["alerts"][number];

/** "1,947.22" → "1947.22"; every figure written in the text. */
function figuresIn(text: string): Set<string> {
  const figures = new Set<string>();
  for (const match of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const value = canonicalizeAmount(match[0].replace(/,/g, ""), { allowZero: true });
    if (value) figures.add(value);
  }
  return figures;
}

function figure(value: string | null | undefined, figures: Set<string>): string | null {
  if (!value) return null;
  const amount = canonicalizeAmount(value.replace(/[^\d.]/g, ""), { allowZero: true });
  return amount && figures.has(amount) ? amount : null;
}

const squash = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();

/** A short source name for the bank: from the sender ID when it's a name ("Ecobank"), else from the model. */
export function sourceSlug(sender: string | null, bank: string | null | undefined): string {
  for (const candidate of [sender, bank]) {
    if (!candidate || !/[a-z]/i.test(candidate) || candidate.includes("@")) continue;
    const slug = candidate
      // "FidelityBank" is "Fidelity Bank"; "Ecobank" and "CalBank" are names of their own.
      .replace(/(?<=[a-z]{4})Bank\b/g, " Bank")
      .toLowerCase()
      .replace(/\b(?:bank|ghana|gh|ltd|limited|plc)\b/g, " ")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 24);
    if (/^momo|mobile_?money|^mtn/.test(slug)) return "momo";
    if (/^[a-z][a-z0-9_]{1,23}$/.test(slug)) return slug;
  }
  return "other";
}

/**
 * Keeps only what the text backs up. Returns null for an alert that moves no
 * money, or whose amount or direction can't be confirmed from the text.
 */
export function checkAlert(text: string, alert: ModelAlert, options: { sender: string | null; now: Date }): ParsedBankMessage | null {
  // Only a provider's own alert goes in the books; a person's message about money never does.
  if (alert.from_provider === false || !alert.moves_money || !alert.direction) return null;
  const figures = figuresIn(text);
  const amount = figure(alert.amount, figures);
  if (!amount || Number(amount) <= 0) return null;
  const said = squash(text);
  const named = alert.counterparty?.trim() && said.includes(squash(alert.counterparty)) ? alert.counterparty.replace(/\s+/g, " ").trim() : "";
  // Card merchants come as codes like SPOTIFY_P47E4EAB37_STOCKHOLM_SE.
  const counterparty = (named.includes("_") ? cardMerchant(named) : named).slice(0, 120);
  const reference = alert.transaction_id?.trim() ?? "";
  const externalId = /^[A-Za-z0-9-]{4,64}$/.test(reference) && text.includes(reference) ? reference : null;
  const balance = figure(alert.balance, figures);
  const source = sourceSlug(options.sender, alert.bank);
  const key = externalId ? `${source}|id|${externalId}` : `${source}|model|${alert.direction}|${amount}|${balance ?? ""}|${counterparty.toLowerCase()}`;
  return {
    source,
    externalId,
    direction: alert.direction,
    amount,
    fee: figure(alert.fee, figures) ?? "0.00",
    counterparty,
    reference: "",
    balance,
    occurredAt: options.now.toISOString(),
    dated: false,
    fingerprint: createHash("sha256").update(key).digest("hex"),
    raw: text.replace(/\s+/g, " ").trim(),
    hold: alert.on_hold === true,
  };
}

export function createUnknownTextReader(settings: DeepSeekSettings, fetchImpl?: typeof fetch): UnknownTextReader {
  return async (text, options) => {
    try {
      const content = await chatCompletion(
        settings,
        [
          { role: "system", content: PROMPT },
          { role: "user", content: JSON.stringify({ sender: options.sender ?? "", text: text.slice(0, 1200) }) },
        ],
        { temperature: 0, maxTokens: 700 },
        fetchImpl,
      );
      const parsed = answerSchema.safeParse(JSON.parse(content));
      if (!parsed.success) return [];
      return parsed.data.alerts.map((alert) => checkAlert(text, alert, options)).filter((item): item is ParsedBankMessage => item !== null);
    } catch (error) {
      logError("bank_read_unknown", error);
      return [];
    }
  };
}
