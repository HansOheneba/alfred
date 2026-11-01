import { createHash } from "node:crypto";

import { canonicalizeAmount } from "@/lib/finance/money";

/** Where a text came from: a known provider, or a short slug for a bank read by the model ("ecobank"). */
export type BankSource = "momo" | "gcb" | "absa" | "other" | (string & {});

const SOURCE_NAMES: Record<string, string> = { momo: "MoMo", gcb: "GCB card", absa: "Absa", other: "Bank" };

/** How a source is named to the person: "MoMo", "Absa", "Ecobank". */
export function sourceName(source: BankSource): string {
  return SOURCE_NAMES[source] ?? source.replace(/[-_]+/g, " ").replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

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
  /** False when no date could be read and occurredAt is just the time it arrived. */
  dated: boolean;
  /** Stable across an SMS and a screenshot of the same SMS, for de-duplication. */
  fingerprint: string;
  raw: string;
  /** A card payment the bank has put on hold ("earmarked"); it counts now, and a later debit may be the same payment. */
  hold?: boolean;
};

type Parsed = Omit<ParsedBankMessage, "occurredAt" | "dated" | "fingerprint"> & {
  /** When the text itself says the payment happened, as wall-clock parts in the person's timezone. */
  at?: { year: number; month: number; day: number; hour: number; minute: number };
};

const MONEY = "([\\d,]+(?:\\.\\d+)?)";

/** Where one message ends and the next begins when several are pasted or read from one screenshot. */
const MESSAGE_START =
  /(?=Payment (?:made|received) for GHS|Dear [A-Z][A-Z .'-]+\.\s*Your Prepaid Card|Dear Customer|Hello, The requested link|Cash (?:In|Out) (?:made|received)|Your payment of GHS|You have (?:received|sent|bought|paid) GHS|Transaction of (?:[A-Z]{3}|GHS)\s*[\d,.]+|GHS\s*[\d,.]+ has been (?:debited|credited))/g;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const TIME = "(\\d{1,2}):(\\d{2})\\s*(AM|PM)?";
/** iPhone Messages headings: "Sun, 4 Oct at 8:15 AM", "Yesterday 11:36 AM", "Saturday 10:12 AM". */
const DATED_HEADER = new RegExp(`(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\\s+)?(\\d{1,2})\\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\s+(?:at\\s+)?${TIME}`, "gi");
const RELATIVE_HEADER = new RegExp(`\\b(Today|Yesterday)\\s*(?:at\\s+)?${TIME}`, "gi");
const WEEKDAY_HEADER = new RegExp(`\\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\\s+(?:at\\s+)?${TIME}`, "gi");
/** A timestamp inside the message itself, e.g. "completed at 2026-10-24 20:23:55". */
const INLINE_TIME = /\b(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/;

type Header = { index: number; length: number; time: string };

function amountOf(value: string | undefined, allowZero = false): string | null {
  if (!value) return null;
  return canonicalizeAmount(value.replace(/,/g, ""), { allowZero });
}

/** "Fee charged: GHS0.38", "Fee was GHS 0.38" and similar. */
function feeOf(text: string): string {
  return amountOf(text.match(new RegExp(`Fee(?: charged| was)?:?\\s*GHS\\s*${MONEY}`, "i"))?.[1], true) ?? "0.00";
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function hour24(hour: string, meridiem: string | undefined): number {
  if (!meridiem) return Number(hour);
  return (Number(hour) % 12) + (meridiem.toUpperCase() === "PM" ? 12 : 0);
}

/** A wall-clock time in the person's timezone, as an ISO instant. */
function localTime(year: number, month: number, day: number, hour: number, minute: number, now: Date, timeZone: string): number {
  return Date.UTC(year, month, day, hour, minute) - zoneOffsetMinutes(now, timeZone) * 60_000;
}

function localParts(now: Date, timeZone: string): { year: number; month: number; day: number; weekday: number } {
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now).split("-").map(Number);
  return { year, month: month - 1, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

/** Every date heading in a screenshot's text, with the time it stands for. */
function findHeaders(text: string, now: Date, timeZone: string): Header[] {
  const today = localParts(now, timeZone);
  const headers: Header[] = [];
  for (const match of text.matchAll(DATED_HEADER)) {
    const month = MONTHS.indexOf(match[2].slice(0, 3).toLowerCase());
    let year = today.year;
    let utc = localTime(year, month, Number(match[1]), hour24(match[3], match[5]), Number(match[4]), now, timeZone);
    // Headings omit the year, so a date in the future must be from last year.
    if (utc > now.getTime() + 36 * 3_600_000) {
      year -= 1;
      utc = localTime(year, month, Number(match[1]), hour24(match[3], match[5]), Number(match[4]), now, timeZone);
    }
    headers.push({ index: match.index ?? 0, length: match[0].length, time: new Date(utc).toISOString() });
  }
  const daysBack = (offset: number, hour: number, minute: number) =>
    localTime(today.year, today.month, today.day - offset, hour, minute, now, timeZone);
  for (const match of text.matchAll(RELATIVE_HEADER)) {
    const offset = match[1].toLowerCase() === "yesterday" ? 1 : 0;
    headers.push({ index: match.index ?? 0, length: match[0].length, time: new Date(daysBack(offset, hour24(match[2], match[4]), Number(match[3]))).toISOString() });
  }
  for (const match of text.matchAll(WEEKDAY_HEADER)) {
    const index = match.index ?? 0;
    // "Sun, 4 Oct at…" is already covered above.
    if (headers.some((item) => index >= item.index && index < item.index + item.length)) continue;
    const offset = (today.weekday - WEEKDAYS.indexOf(match[1].toLowerCase()) + 7) % 7 || 7;
    headers.push({ index, length: match[0].length, time: new Date(daysBack(offset, hour24(match[2], match[4]), Number(match[3]))).toISOString() });
  }
  return headers.sort((left, right) => left.index - right.index);
}

function stripHeaders(text: string): string {
  return text.replace(DATED_HEADER, " ").replace(RELATIVE_HEADER, " ").replace(WEEKDAY_HEADER, " ");
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

/** "11 Oct 2026 17:37" as wall-clock parts. */
function namedDate(day: string, month: string, year: string, hour: string, minute: string): Parsed["at"] {
  const index = MONTHS.indexOf(month.slice(0, 3).toLowerCase());
  return index < 0 ? undefined : { year: Number(year), month: index, day: Number(day), hour: Number(hour), minute: Number(minute) };
}

/** "11/10/26 18:33" (day first) as wall-clock parts. */
function slashDate(day: string, month: string, year: string, hour: string, minute: string): Parsed["at"] {
  const full = year.length === 2 ? 2000 + Number(year) : Number(year);
  return { year: full, month: Number(month) - 1, day: Number(day), hour: Number(hour), minute: Number(minute) };
}

/**
 * A card merchant as a person would say it: "Spotify" from
 * "Spotify_P47E4EAB37_STOCKHOLM_SE", "APPLE.COM/BILL" from "APPLE.COM/BILL_ITUNES.COM_IE".
 */
export function cardMerchant(value: string): string {
  const tokens = value.replace(/[\s-]*\n[\s-]*/g, "").split(/[_*\s]+/).filter(Boolean);
  // A reference code mixes letters and digits, like P47E4EAB37; the name is what comes before it.
  const code = tokens.findIndex((token, index) => index > 0 && token.length >= 6 && /\d/.test(token) && /[a-z]/i.test(token));
  let kept = code > 0 ? tokens.slice(0, code) : tokens;
  // A trailing two-letter country code (SE, IE, US) isn't part of the name.
  if (kept.length > 1 && /^[A-Z]{2}$/.test(kept[kept.length - 1])) kept = kept.slice(0, -1);
  if (kept.length > 2) kept = kept.slice(0, 2);
  return clean(kept.join(" ")).slice(0, 120);
}

const DATE_WORDS = "(\\d{1,2})\\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\s+(\\d{4})\\s+(\\d{1,2}):(\\d{2})";

/**
 * Absa Ghana alerts. Returns undefined when the text isn't one, and null for
 * Absa texts that move no money, like a declined card payment.
 */
function parseAbsa(text: string): Parsed | null | undefined {
  if (/transaction has been declined|declined due to insufficient/i.test(text)) return null;

  // "Transaction of [USD 5.99 equivalent to] GHS 75.56 earmarked on your account ending 9746 as of 07 Oct 2026 13:37 at APPLE.COM/BILL… Available balance is GHS 3321.31."
  const hold = text.match(
    new RegExp(`Transaction of (?:([A-Z]{3})\\s*${MONEY}\\s+equivalent to\\s+)?GHS\\s*${MONEY}\\s+earmarked on your account ending\\s*(\\d{3,})\\s+as of\\s+${DATE_WORDS}\\s+at\\s+(.+?)\\.\\s*Available balance is\\s*GHS\\s*${MONEY}`, "i"),
  );
  if (hold) {
    const amount = amountOf(hold[3]);
    if (!amount) return null;
    return {
      source: "absa",
      externalId: null,
      direction: "out",
      amount,
      fee: "0.00",
      counterparty: cardMerchant(hold[10]),
      reference: hold[1] ? `${hold[1].toUpperCase()} ${hold[2]}` : "",
      balance: amountOf(hold[11], true),
      raw: text,
      hold: true,
      at: namedDate(hold[5], hold[6], hold[7], hold[8], hold[9]),
    };
  }

  // "GHS 100.00 has been debited to your account ending 9746 as of 11 Oct 2026 18:33. Your available balance is 1,947.22"
  const moved = text.match(
    new RegExp(`GHS\\s*${MONEY}\\s+has been (debited|credited) (?:to|from|on|into) your account ending\\s*(\\d{3,})\\s+as of\\s+${DATE_WORDS}\\.?\\s*Your available balance is\\s*(?:GHS\\s*)?${MONEY}`, "i"),
  );
  if (moved) {
    const amount = amountOf(moved[1]);
    if (!amount) return null;
    return {
      source: "absa",
      externalId: null,
      direction: moved[2].toLowerCase() === "debited" ? "out" : "in",
      amount,
      fee: "0.00",
      counterparty: "",
      reference: "",
      balance: amountOf(moved[9], true),
      raw: text,
      at: namedDate(moved[4], moved[5], moved[6], moved[7], moved[8]),
    };
  }

  // "Transfer of GHS100 from your account ending 9746 to 233598921110 MITCH IVAN ABAKAH on 11/10/26 18:33 was successful. WALLET TxnID 17917435530888"
  const transfer = text.match(
    new RegExp(`Transfer of GHS\\s*${MONEY}\\s+from your account ending\\s*(\\d{3,})\\s+to\\s+(?:(\\d{6,})\\s+)?(.+?)\\s+on\\s+(\\d{1,2})\\/(\\d{1,2})\\/(\\d{2,4})\\s+(\\d{1,2}):(\\d{2})\\s+was successful`, "i"),
  );
  if (transfer) {
    const amount = amountOf(transfer[1]);
    if (!amount) return null;
    const number = transfer[3] ? transfer[3].replace(/^233/, "0") : "";
    return {
      source: "absa",
      externalId: text.match(/TxnID\s*:?\s*(\d{6,})/i)?.[1] ?? null,
      direction: "out",
      amount,
      fee: "0.00",
      counterparty: clean(transfer[4]).slice(0, 120),
      reference: number ? `to ${number}` : "",
      balance: null,
      raw: text,
      at: slashDate(transfer[5], transfer[6], transfer[7], transfer[8], transfer[9]),
    };
  }
  return undefined;
}

function parseOne(body: string, hint: BankSource | null, generic: boolean): Parsed | null {
  const text = clean(body);
  const externalId = text.match(/(?:Transaction ID|Financial Transaction Id|Trans(?:action)? Id)\s*:?\s*(\d{6,})/i)?.[1] ?? null;
  const momoBalance = amountOf(text.match(new RegExp(`(?:Current|new) balance:?\\s*GHS\\s*${MONEY}`, "i"))?.[1], true);
  const reference = clean(text.match(/Reference:\s*([^]*?)(?:\.\s+Transaction ID|Transaction ID|$)/i)?.[1] ?? "").slice(0, 160);

  const made = text.match(new RegExp(`Payment made for GHS\\s*${MONEY}\\s+to\\s+(.+?)\\s+Current Balance`, "i"));
  if (made) {
    const amount = amountOf(made[1]);
    if (!amount) return null;
    return { source: "momo", externalId, direction: "out", amount, fee: feeOf(text), counterparty: clean(made[2]).slice(0, 120), reference, balance: momoBalance, raw: text };
  }

  const received = text.match(new RegExp(`Payment received for GHS\\s*${MONEY}\\s+from\\s+(.+?)\\s+Current Balance`, "i"));
  if (received) {
    const amount = amountOf(received[1]);
    if (!amount) return null;
    return { source: "momo", externalId, direction: "in", amount, fee: "0.00", counterparty: clean(received[2]).slice(0, 120), reference, balance: momoBalance, raw: text };
  }

  // Merchant and cross-network payments: "Your payment of GHS 30.50 to TELECEL PUSH has been completed at …".
  // Bundles and bills: "Payment for GHS444.00 to Broadband Bundle OVA.Current Balance: …".
  const paidFor = text.match(new RegExp(`Payment for GHS\\s*${MONEY}\\s+to\\s+(.+?)\\s*\\.?\\s*Current Balance`, "i"));
  if (paidFor) {
    const amount = amountOf(paidFor[1]);
    if (!amount) return null;
    return { source: "momo", externalId, direction: "out", amount, fee: feeOf(text), counterparty: clean(paidFor[2]).replace(/\.$/, "").slice(0, 120), reference, balance: momoBalance, raw: text };
  }

  const completed = text.match(new RegExp(`Your payment of GHS\\s*${MONEY}\\s+to\\s+(.+?)\\s+has been completed`, "i"));
  if (completed) {
    const amount = amountOf(completed[1]);
    if (!amount) return null;
    return {
      source: "momo",
      externalId,
      direction: "out",
      amount,
      fee: feeOf(text),
      counterparty: clean(completed[2]).slice(0, 120),
      reference,
      balance: momoBalance ?? amountOf(text.match(new RegExp(`new balance:?\\s*GHS\\s*${MONEY}`, "i"))?.[1], true),
      raw: text,
    };
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

  const absa = parseAbsa(text);
  if (absa !== undefined) return absa;

  // Other mobile money wordings: an amount plus a clear direction word.
  if (!generic) return null;
  const loose = text.match(new RegExp(`GHS\\s*${MONEY}`, "i"));
  if (!loose) return null;
  const amount = amountOf(loose[1]);
  if (!amount) return null;
  const out = /\b(sent|paid|payment made|payment of|debited|cash out|purchase|bought|withdraw|transferred)/i.test(text);
  const inbound = /\b(received|credited|cash in|deposit)/i.test(text);
  if (out === inbound) return null;
  const party = text.match(out ? /\bto\s+([A-Z][A-Z0-9 .&'-]{2,60}?)(?=\s+(?:on|at|Current|Your|Ref|\.|,)|$)/ : /\bfrom\s+([A-Z][A-Z0-9 .&'-]{2,60}?)(?=\s+(?:on|at|Current|Your|Ref|\.|,)|$)/);
  const fee = feeOf(text);
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

function fingerprint(message: Parsed): string {
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
  // The loose fallback is for MoMo and GCB wordings; texts from another named sender are left to the model reader.
  const generic = !options.sender?.trim() || hint !== null;
  const headers = findHeaders(text, options.now, options.timeZone);
  const starts = [...text.matchAll(MESSAGE_START)].map((match) => match.index ?? 0);
  const bounds = starts.length > 0 ? starts : [0];
  if (bounds[0] !== 0 && text.slice(0, bounds[0]).trim().length > 40 && !headers.length) bounds.unshift(0);

  const results: ParsedBankMessage[] = [];
  bounds.forEach((start, index) => {
    const end = bounds[index + 1] ?? text.length;
    // Strip any date header that sits between this message and the next.
    const body = stripHeaders(text.slice(start, end));
    const result = parseOne(body, hint, generic);
    if (!result) return;
    const { at, ...parsed } = result;
    const inline = INLINE_TIME.exec(body);
    const header = [...headers].reverse().find((item) => item.index <= start);
    // A message above the first readable heading arrived before it, so borrow that heading's date.
    const next = header ? null : headers.find((item) => item.index > start);
    const occurredAt = at
      ? new Date(localTime(at.year, at.month, at.day, at.hour, at.minute, options.now, options.timeZone)).toISOString()
      : inline
        ? new Date(localTime(Number(inline[1]), Number(inline[2]) - 1, Number(inline[3]), Number(inline[4]), Number(inline[5]), options.now, options.timeZone)).toISOString()
        : (header?.time ?? (next ? new Date(Date.parse(next.time) - 60_000).toISOString() : options.now.toISOString()));
    results.push({ ...parsed, occurredAt, dated: Boolean(at || inline || header || next), fingerprint: fingerprint(result) });
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

/** "Transfer to HANS OHENEBA …" in a reference names the person receiving, not who sent it. */
export function withoutRecipient(reference: string): string {
  return reference.replace(/\b[Tt]ransfer [Tt]o(?:\s+[A-Z]{2,})+/g, " ");
}

/**
 * What the sender wrote about a payment, from the text's reference, without
 * the names, masked account numbers and bank boilerplate around it: "WiFi"
 * from "WENDY … ,03xxxxxx61,Transfer to HANS … WiFi (GIP) from ACCESS Bank
 * Limited". Empty when nothing is left.
 */
export function purposeOf(message: { raw: string; counterparty: string }): string {
  const reference = clean(message.raw.match(/Reference:\s*([^]*?)(?:\.\s+Transaction ID|Transaction ID|$)/i)?.[1] ?? "");
  const name = message.counterparty.trim();
  const purpose = withoutRecipient(name ? reference.split(name).join(" ") : reference)
    .replace(/\b\d{2}x+\d{2}\b/gi, " ")
    .replace(/\(?\bGIPS?\b\)?/gi, " ")
    .replace(/\b(?:transfer\s+)?from\s+[A-Za-z .&]*?\bbank(?:\s+(?:limited|ltd|plc))?\b/gi, " ")
    .replace(/\btransfer\b/gi, " ")
    .replace(/[\s,.;:-]+/g, " ")
    .trim();
  return /[a-z]{2,}/i.test(purpose) ? purpose.slice(0, 80) : "";
}

/** A stable key for remembering a payee: case, spacing and punctuation don't matter. */
export function payeeKey(counterparty: string): string {
  return counterparty.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 120);
}

/**
 * The last four digits of the account a text is about, like "0543" from
 * "Your A/C No:XXXX0543", or null when the text doesn't name one.
 */
export function accountOf(text: string): string | null {
  const match = text.match(/\b(?:A\/C|Acct|Account)(?:\s*(?:No\.?|Number|ending(?: in)?))?\s*[:.#]?\s*[X*x•.\s-]*(\d{3,})\b/i);
  return match ? match[1].slice(-4) : null;
}
