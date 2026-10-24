import { formatMinor } from "@/lib/finance/money";

/** Short money for chart axes: GH₵1.2k rather than GH₵1,200.00. */
export function compactMoney(minor: number, currency: string): string {
  const value = minor / 100;
  try {
    return new Intl.NumberFormat("en-GH", { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 }).format(value);
  } catch {
    return formatMinor(minor, currency);
  }
}

/** "+12% vs previous" style delta. For spending, up is bad; for income, up is good. */
export function delta(current: number, previous: number, upIsGood: boolean): { text: string; tone?: "good" | "bad" } {
  if (previous === 0 && current === 0) return { text: "No activity in either period" };
  if (previous === 0) return { text: "Nothing in the previous period" };
  const change = Math.round(((current - previous) / Math.abs(previous)) * 100);
  if (change === 0) return { text: "Same as previous period" };
  const up = change > 0;
  return { text: `${up ? "+" : ""}${change}% vs previous period`, tone: up === upIsGood ? "good" : "bad" };
}

export function percent(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}
