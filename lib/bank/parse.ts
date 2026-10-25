import { createHash } from "node:crypto";

import { canonicalizeAmount } from "@/lib/finance/money";

export type BankSource = "momo" | "gcb" | "other";

/** One money movement read from an SMS. Amounts are canonical "123.45" strings. */
export type ParsedBankMessage = {
  source: BankSource;
  externalId: string | null;
  direction: "in" | "out";
  amount: string;
  fee: string;
  counterparty: string;
  /** Extra text that may name the sender, such as a MoMo reference. */
  reference: string;
  balance: string | null;
  occurredAt: string;
  /** Stable across an SMS and a screenshot of the same SMS, for de-duplication. */
  fingerprint: string;
  raw: string;
};

const MONEY = "([\\d,]+(?:\\.\\d+)?)";

/** Where one message ends and the next begins when several are pasted or read from one screenshot. */
const MESSAGE_START =
  /(?=Payment (?:made|received) for GHS|Dear [A-Z][A-Z .'-]+\.\s*Your Prepaid Card|Dear Customer|Hello, The requested link|Cash (?:In|Out) (?:made|received)|Your payment of GHS|You have (?:received|sent|bought|paid) GHS)/g;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DATE_HEADER =
  /(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(AM|PM)?/gi;

function amountOf(value: string | undefined, allowZero = false): string | null {
  if (!value) return null;
  return canonicalizeAmount(value.replace(/,/g, ""), { allowZero });
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Turns a "Sun, 4 Oct at 8:15 AM" header into a timestamp in the person's timezone, in the most recent matching year. */
function headerTime(match: RegExpExecArray, now: Date, timeZone: string): string {
  const day = Number(match[1]);
  const month = MONTHS.indexOf(match[2].slice(0, 3).toLowerCase());
  let hour = Number(match[3]) % 12;
  if ((match[5] ?? "").toUpperCase() === "PM") hour += 12;
  if (!match[5]) hour = Number(match[3]);
  const minute = Number(match[4]);
  const offsetMinutes = zoneOffsetMinutes(now, timeZone);
  let year = Number(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric" }).format(now));
  let utc = Date.UTC(year, month, day, hour, minute) - offsetMinutes * 60_000;
  if (utc > now.getTime() + 36 * 3_600_000) {
    year -= 1;
    utc = Date.UTC(year, month, day, hour, minute) - offsetMinutes * 60_000;
  }
  return new Date(utc).toISOString();
}

function zoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return Math.round((asUtc - date.getTime()) / 60_000);
}

function parseOne(body: string, hint: BankSource | null): Omit<ParsedBankMessage, "occurredAt" | "fingerprint"> | null {
  const text = clean(body);
  const externalId = text.match(/(?:Transaction ID|Financial Transaction Id|Trans(?:action)? Id)\s*:?\s*(\d{6,})/i)?.[1] ?? null;
  const momoBalance = amountOf(text.match(new RegExp(`Current Balance:\\s*GHS\\s*${MONEY}`, "i"))?.[1], true);
  const reference = clean(text.match(/Reference:\s*([^]*?)(?:\.\s+Transaction ID|Transaction ID|$)/i)?.[1] ?? "").slice(0, 160);

  const made = text.match(new RegExp(`Payment made for GHS\\s*${MONEY}\\s+to\\s+(.+?)\\s+Current Balance`, "i"));
  if (made) {
    const amount = amountOf(made[1]);
    if (!amount) return null;
    const fee = amountOf(text.match(new RegExp(`Fee charged:\\s*GHS\\s*${MONEY}`, "i"))?.[1], true) ?? "0.00";
    return { source: "momo", externalId, direction: "out", amount, fee, counterparty: clean(made[2]).slice(0, 120), reference, balance: momoBalance, raw: text };
  }

  const received = text.match(new RegExp(`Payment received for GHS\\s*${MONEY}\\s+from\\s+(.+?)\\s+Current Balance`, "i"));
  if (received) {
    const amount = amountOf(received[1]);
    if (!amount) return null;
    return { source: "momo", externalId, direction: "in", amount, fee: "0.00", counterparty: clean(received[2]).slice(0, 120), reference, balance: momoBalance, raw: text };
  }

  const cardDebit = text.match(new RegExp(`Prepaid Card.*?debited with\\s+amount of\\s*:\\s*${MONEY}\\s*(?:GHANA CEDIS|GHS)\\.?\\s*Your balance is\\s*${MONEY}`, "i"));
  if (cardDebit) {
    const amount = amountOf(cardDebit[1]);
    if (!amount) return null;
    return { source: "gcb", externalId, direction: "out", amount, fee: "0.00", counterparty: "GCB prepaid card", reference: "", balance: amountOf(cardDebit[2], true), raw: text };
  }

  const cardCredit = text.match(new RegExp(`Prepaid Card.*?credited with an amount of\\s*:\\s*${MONEY}\\s*(?:GHANA CEDIS|GHS)\\.?\\s*Your balance is\\s*${MONEY}`, "i"));
  if (cardCredit) {
    const amount = amountOf(cardCredit[1]);
    if (!amount) return null;
    return { source: "gcb", externalId, direction: "in", amount, fee: "0.00", counterparty: "GCB prepaid card top-up", reference: "", balance: amountOf(cardCredit[2], true), raw: text };
  }

  // Other mobile money wordings: an amount plus a clear direction word.
  const generic = text.match(new RegExp(`GHS\\s*${MONEY}`, "i"));
  if (!generic) return null;
  const amount = amountOf(generic[1]);
  if (!amount) return null;
  const out = /\b(sent|paid|payment made|debited|cash out|purchase|bought|withdraw)/i.test(text);
  const inbound = /\b(received|credited|cash in|deposit)/i.test(text);
  if (out === inbound) return null;
  const party = text.match(out ? /\bto\s+([A-Z][A-Z0-9 .&'-]{2,60}?)(?=\s+(?:on|at|Current|Your|Ref|\.|,)|$)/ : /\bfrom\s+([A-Z][A-Z0-9 .&'-]{2,60}?)(?=\s+(?:on|at|Current|Your|Ref|\.|,)|$)/);
  const fee = amountOf(text.match(new RegExp(`Fee(?: charged)?:?\\s*GHS\\s*${MONEY}`, "i"))?.[1], true) ?? "0.00";
  return {
    source: hint ?? (/gcb/i.test(text) ? "gcb" : "momo"),
    externalId,
    direction: out ? "out" : "in",
    amount,
    fee,
    counterparty: clean(party?.[1] ?? "").slice(0, 120),
    reference,
    balance: momoBalance ?? amountOf(text.match(new RegExp(`balance(?: is)?:?\\s*(?:GHS)?\\s*${MONEY}`, "i"))?.[1], true),
    raw: text,
  };
}

function fingerprint(message: Omit<ParsedBankMessage, "occurredAt" | "fingerprint">): string {
  const key = message.externalId
    ? `${message.source}|id|${message.externalId}`
    : `${message.source}|${message.direction}|${message.amount}|${message.balance ?? ""}|${message.counterparty.toLowerCase()}`;
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Reads every money movement in a block of text: one forwarded SMS, or the
 * text of a screenshot holding several. Promotions and notices are skipped.
 */
export function parseBankText(
  text: string,
  options: { now: Date; timeZone: string; sender?: string | null },
): ParsedBankMessage[] {
  const hint: BankSource | null = options.sender
    ? /gcb/i.test(options.sender)
      ? "gcb"
      : /momo|mobile ?money|mtn/i.test(options.sender)
        ? "momo"
        : null
    : null;
  const headers: { index: number; time: string }[] = [];
  for (const match of text.matchAll(DATE_HEADER)) {
    headers.push({ index: match.index ?? 0, time: headerTime(match as RegExpExecArray, options.now, options.timeZone) });
  }
  const starts = [...text.matchAll(MESSAGE_START)].map((match) => match.index ?? 0);
  const bounds = starts.length > 0 ? starts : [0];
  if (bounds[0] !== 0 && text.slice(0, bounds[0]).trim().length > 40 && !headers.length) bounds.unshift(0);

  const results: ParsedBankMessage[] = [];
  bounds.forEach((start, index) => {
    const end = bounds[index + 1] ?? text.length;
    // Strip any date header that sits between this message and the next.
    const body = text.slice(start, end).replace(DATE_HEADER, " ");
    const parsed = parseOne(body, hint);
    if (!parsed) return;
    const header = [...headers].reverse().find((item) => item.index <= start);
    // A message above the first readable heading arrived before it, so borrow that heading's date.
    const next = header ? null : headers.find((item) => item.index > start);
    const occurredAt = header?.time ?? (next ? new Date(Date.parse(next.time) - 60_000).toISOString() : options.now.toISOString());
    results.push({ ...parsed, occurredAt, fingerprint: fingerprint(parsed) });
  });
  return results;
}

/** True when a name in the message matches one of the person's own account names. */
export function isOwnName(text: string, accountNames: string[]): boolean {
  const words = new Set(text.toUpperCase().split(/[^A-Z]+/).filter((word) => word.length > 1));
  return accountNames.some((name) => {
    const parts = name.toUpperCase().split(/[^A-Z]+/).filter((word) => word.length > 1);
    if (parts.length === 0) return false;
    const hits = parts.filter((part) => words.has(part)).length;
    return hits === parts.length || hits >= 3;
  });
}

/** A stable key for remembering a payee: case, spacing and punctuation don't matter. */
export function payeeKey(counterparty: string): string {
  return counterparty.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 120);
}
