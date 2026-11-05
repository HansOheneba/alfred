import type { LedgerRow, RangePreset } from "@/lib/finance/analytics";
import type { OverviewTransactionFilters } from "./activity-handoff";

export const OVERVIEW_PAGE_SIZE = 15;
export type OverviewTransactionQuery = { preset: RangePreset; category: string | null; filters: OverviewTransactionFilters };
export type OverviewTransactionPage = { rows: LedgerRow[]; total: number; nextCursor: string | null; version: string; queryKey: string; categories: string[] };

export function overviewTransactionQueryKey(query: OverviewTransactionQuery): string {
  return JSON.stringify([query.preset, query.category, query.filters.search.trim(), query.filters.type, query.filters.category, query.filters.sort]);
}

export function overviewTransactionQueryParams(query: OverviewTransactionQuery): URLSearchParams {
  const params = new URLSearchParams({ range: query.preset, tx_q: query.filters.search, tx_type: query.filters.type, tx_category: query.filters.category, tx_sort: query.filters.sort });
  if (query.category) params.set("category", query.category);
  return params;
}

export function filterOverviewTransactions(rows: LedgerRow[], filters: OverviewTransactionFilters): LedgerRow[] {
  const needle = filters.search.trim().toLowerCase();
  const list = rows.filter(row =>
    (filters.type === "all" || row.type === filters.type) && (filters.category === "all" || row.category === filters.category)
    && (!needle || row.description.toLowerCase().includes(needle) || row.category.toLowerCase().includes(needle)));
  return [...list].sort((left, right) => {
    if (filters.sort === "amount-desc") return right.minor - left.minor;
    if (filters.sort === "amount-asc") return left.minor - right.minor;
    const byDate = left.date.localeCompare(right.date);
    return filters.sort === "date-asc" ? byDate : -byDate;
  });
}
