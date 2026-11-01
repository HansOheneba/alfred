/** What kinds of investment Alfred tracks, and their names. Plain data, safe for the browser. */
export const INVESTMENT_KINDS = ["us_stocks", "gse_stocks", "tbill", "fixed_deposit", "bond", "mutual_fund", "pension", "crypto", "other"] as const;
export type InvestmentKind = (typeof INVESTMENT_KINDS)[number];

export const KIND_LABELS: Record<InvestmentKind, string> = {
  us_stocks: "US stocks",
  gse_stocks: "Ghana stocks",
  tbill: "Treasury bill",
  fixed_deposit: "Fixed deposit",
  bond: "Bond",
  mutual_fund: "Mutual fund",
  pension: "Pension",
  crypto: "Crypto",
  other: "Other",
};

/** Kinds that grow by a rate until they mature, rather than by market prices. */
export const FIXED_INCOME: readonly InvestmentKind[] = ["tbill", "fixed_deposit", "bond"];

export type Market = "us" | "gse" | "fx";

/** Where a kind's holdings are priced: US closes, the GSE board, or neither. */
export function marketFor(kind: InvestmentKind): Market | null {
  return kind === "us_stocks" ? "us" : kind === "gse_stocks" ? "gse" : null;
}
