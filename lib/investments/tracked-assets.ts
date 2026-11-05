import type { IncludedAccountCash } from "@/lib/finance/accounting/cash-summary";
import type { Portfolio } from "./value";

/** An assets subtotal, never net worth: debts and unrecorded assets are outside this view. */
export function trackedAssets(cash: IncludedAccountCash, portfolio: Portfolio) {
  const unknownInvestmentCount = portfolio.items.filter((item) => item.valueGhs === null).length;
  // Portfolio aggregates contain only valued items. A missing value must not
  // silently remove an active investment's unknown basis from this summary.
  const knownBasis = portfolio.items.filter((item) => item.investedGhs !== null && !item.investment.importCostBasisUnknown && (
    item.investment.currency === "GHS" || item.investment.currency === "USD" && portfolio.usdGhs !== null && portfolio.usdGhs > 0
  ));
  const unknownBasisCount = portfolio.items.length - knownBasis.length;
  const investedGhs = unknownBasisCount > 0 ? null : Math.round(knownBasis.reduce((sum, item) => sum + item.investedGhs!, 0) * 100) / 100;
  const gainGhs = investedGhs === null || investedGhs <= 0 || unknownInvestmentCount > 0 ? null : Math.round((portfolio.totalGhs - investedGhs) * 100) / 100;
  const investmentMinorGhs = Math.round(portfolio.totalGhs * 100);
  const cashMinorGhs = cash.totalMinor === null ? null : cash.currency === "GHS" ? cash.totalMinor
    : cash.currency === "USD" && portfolio.usdGhs !== null && portfolio.usdGhs > 0 ? Math.round(cash.totalMinor * portfolio.usdGhs) : null;
  const reason = cash.totalMinor === null ? "cash-unavailable" : cashMinorGhs === null ? "currency-unavailable" : unknownInvestmentCount > 0 ? "investment-unavailable" : null;
  return { totalMinorGhs: reason === null ? cashMinorGhs! + investmentMinorGhs : null, cashMinorGhs, investmentMinorGhs, unknownInvestmentCount, investedGhs, gainGhs, unknownBasisCount, reason };
}
