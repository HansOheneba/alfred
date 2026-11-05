import { isRealDate } from "@/lib/finance/dates";

export type ActivitySort = "date-desc" | "date-asc" | "amount-desc" | "amount-asc";
export type OverviewTransactionFilters = { search: string; type: "all" | "expense" | "income"; category: string; sort: ActivitySort };
export type ActivityHandoff = Omit<OverviewTransactionFilters, "category"> & { start: string; end: string; category: string; currency: string };
const sorts: readonly string[] = ["date-desc", "date-asc", "amount-desc", "amount-asc"];
const text = (value: unknown, limit: number) => typeof value === "string" && value.trim().length <= limit ? value.trim() : "";
const day = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && isRealDate(value) ? value : "";

function normalize(input: Partial<ActivityHandoff>): ActivityHandoff {
  let start = day(input.start), end = day(input.end);
  if (start && end && start > end) { start = ""; end = ""; }
  return {
    start, end,
    category: input.category === "all" ? "" : text(input.category, 40),
    currency: typeof input.currency === "string" && /^[A-Z]{3}$/.test(input.currency) ? input.currency : "",
    search: text(input.search, 200),
    type: input.type === "expense" || input.type === "income" ? input.type : "all",
    sort: sorts.includes(input.sort ?? "") ? input.sort! : "date-desc",
  };
}

/** Read-only view state; no owner identifiers or transaction contents are persisted. */
export function parseActivityHandoff(search: string): ActivityHandoff {
  const params = new URLSearchParams(search);
  return normalize({ start: params.get("from") ?? "", end: params.get("to") ?? "", category: params.get("category") ?? "", currency: params.get("currency") ?? "", search: params.get("q") ?? "", type: params.get("type") as ActivityHandoff["type"], sort: params.get("sort") as ActivitySort });
}

export function activityHref(input: Partial<ActivityHandoff>): string {
  const filters = normalize(input), params = new URLSearchParams({ tab: "activity" });
  if (filters.start) params.set("from", filters.start);
  if (filters.end) params.set("to", filters.end);
  if (filters.category) params.set("category", filters.category);
  if (filters.currency) params.set("currency", filters.currency);
  if (filters.search) params.set("q", filters.search);
  if (filters.type !== "all") params.set("type", filters.type);
  if (filters.sort !== "date-desc") params.set("sort", filters.sort);
  return `/accounts?${params}`;
}

export function parseOverviewTransactionFilters(search: string): OverviewTransactionFilters {
  const params = new URLSearchParams(search);
  const value = normalize({ search: params.get("tx_q") ?? "", type: params.get("tx_type") as ActivityHandoff["type"], category: params.get("tx_category") ?? "", sort: params.get("tx_sort") as ActivitySort });
  return { search: value.search, type: value.type, category: value.category || "all", sort: value.sort };
}

export function overviewTransactionSearch(search: string, input: OverviewTransactionFilters): string {
  const params = new URLSearchParams(search), value = normalize(input);
  for (const key of ["tx_q", "tx_type", "tx_category", "tx_sort"]) params.delete(key);
  if (value.search) params.set("tx_q", value.search);
  if (value.type !== "all") params.set("tx_type", value.type);
  if (value.category) params.set("tx_category", value.category);
  if (value.sort !== "date-desc") params.set("tx_sort", value.sort);
  return params.toString();
}
