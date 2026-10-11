import { LIMITS } from "@/lib/config";

const POSITIVE_AMOUNT = /^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/;

export function toMinor(amount: string): number {
  const negative = amount.startsWith("-");
  const unsigned = negative ? amount.slice(1) : amount;
  const [whole, fraction = ""] = unsigned.split(".");
  if (!/^(?:0|[1-9]\d*)$/.test(whole) || fraction.length > 2) {
    throw new Error("Invalid amount.");
  }
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return negative ? -minor : minor;
}

export function canonicalizeAmount(
  value: unknown,
  options?: { allowZero?: boolean },
): string | null {
  const allowZero = options?.allowZero ?? false;
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    if (Object.is(value, -0)) return null;
    const raw = value.toString();
    if (/e/i.test(raw)) return null;
    text = raw;
  } else if (typeof value === "string") {
    text = value.trim().replace(/,/g, "").replace(/\s+/g, "");
    text = text.replace(/^(?:GH₵|GHS|₵)/i, "");
  } else {
    return null;
  }

  if (!POSITIVE_AMOUNT.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const canonical = `${whole}.${fraction.padEnd(2, "0")}`;
  const minor = toMinor(canonical);
  if (minor > LIMITS.maxMinor) return null;
  if (minor < 0) return null;
  if (minor === 0 && !allowZero) return null;
  return canonical;
}

export function formatMinor(minor: number, currency: string): string {
  const negative = minor < 0;
  const absolute = Math.abs(minor);
  const amount = `${negative ? "-" : ""}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
  return new Intl.NumberFormat("en-GH", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(amount));
}

export function formatAmount(amount: string, currency: string): string {
  return formatMinor(toMinor(amount), currency);
}
