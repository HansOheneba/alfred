import { RANGE_LABELS, type RangePreset } from "@/lib/finance/analytics";

export type OverviewView = {
  preset: RangePreset;
  category: string | null;
  dailyMode: "daily" | "cumulative";
  insightsOpen: boolean;
};

export const DEFAULT_OVERVIEW_VIEW: OverviewView = { preset: "this_month", category: null, dailyMode: "daily", insightsOpen: false };

/** Display preferences live in this history entry's URL, never a shared account cache. */
export function overviewViewFromParams(params: Pick<URLSearchParams, "get">): OverviewView {
  const range = params.get("range"), category = params.get("category")?.trim();
  return {
    preset: range && Object.hasOwn(RANGE_LABELS, range) ? range as RangePreset : "this_month",
    category: category && category.length <= 40 ? category : null,
    dailyMode: params.get("chart") === "cumulative" ? "cumulative" : "daily",
    insightsOpen: params.get("insights") === "1",
  };
}

export function overviewViewHref(href: string, view: OverviewView): string {
  const url = new URL(href, "https://alfred.invalid");
  const entries = { range: view.preset === "this_month" ? null : view.preset, category: view.category, chart: view.dailyMode === "daily" ? null : view.dailyMode, insights: view.insightsOpen ? "1" : null };
  for (const [key, value] of Object.entries(entries)) {
    if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function overviewScrollPosition(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 2_000_000 ? value : null;
}
