import { createHash } from "node:crypto";
import { z } from "zod";
import type { StudioSettings, UserProfile } from "@/lib/config";
import { inRows, presetRange, toLedgerRows, type LedgerRow } from "@/lib/finance/analytics";
import { withLedgerReceipts } from "@/lib/finance/accounting/receipts";
import { loadAccountingReadModel, type AccountingResult } from "@/lib/finance/accounting/persisted-store";
import { projectAccountingTransactions } from "@/lib/finance/accounting/view";
import { zonedYmd } from "@/lib/finance/dates";
import { loadLedgerSnapshot } from "./ledger";
import { buildOverviewSummary } from "./overview-summary";
import { filterOverviewTransactions, OVERVIEW_PAGE_SIZE, overviewTransactionQueryKey, type OverviewTransactionPage, type OverviewTransactionQuery } from "./overview-transactions";

const querySchema = z.strictObject({
  preset: z.enum(["this_month", "last_month", "last_3_months", "last_6_months", "this_year", "all"]),
  category: z.string().trim().min(1).max(40).nullable(),
  filters: z.strictObject({ search: z.string().max(200), type: z.enum(["all", "expense", "income"]), category: z.string().min(1).max(40), sort: z.enum(["date-desc", "date-asc", "amount-desc", "amount-asc"]) }),
});
const cursorSchema = z.strictObject({ offset: z.number().int().min(0).max(100_000_000), version: z.string().regex(/^[a-f0-9]{64}$/), queryHash: z.string().regex(/^[a-f0-9]{64}$/) });
export class InvalidOverviewPage extends Error {
  constructor() { super("That transaction page could not be read. Refresh Overview and try again."); }
}
export class OverviewChanged extends Error {
  constructor() { super("Your financial records changed. Refresh Overview before loading more transactions."); }
}
export function parseOverviewTransactionQuery(params: URLSearchParams): OverviewTransactionQuery {
  const allowed = new Set(["range", "category", "tx_q", "tx_type", "tx_category", "tx_sort", "cursor"]);
  for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1) throw new Error("Check the transaction filters.");
  return querySchema.parse({ preset: params.get("range") ?? "this_month", category: params.get("category"), filters: { search: params.get("tx_q") ?? "", type: params.get("tx_type") ?? "all", category: params.get("tx_category") ?? "all", sort: params.get("tx_sort") ?? "date-desc" } });
}
function reportVersion(profile: UserProfile, accounting: AccountingResult, rows: LedgerRow[], today: string): string {
  // The legacy path has no durable source version, so fingerprint its actual read.
  return createHash("sha256").update(JSON.stringify([profile.profileId, profile.currency, today, accounting.state.revision, accounting.sourceVersion ?? rows])).digest("hex");
}
export function overviewTransactionPage(profile: UserProfile, accounting: AccountingResult, rows: LedgerRow[], today: string, input: OverviewTransactionQuery, cursor: string | null = null): OverviewTransactionPage {
  const query = querySchema.parse(input), queryKey = overviewTransactionQueryKey(query), version = reportVersion(profile, accounting, rows, today);
  const queryHash = createHash("sha256").update(queryKey).digest("hex");
  let offset = 0;
  if (cursor) {
    let value: z.infer<typeof cursorSchema>;
    try {
      if (cursor.length > 1200 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("Invalid cursor");
      value = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    } catch { throw new InvalidOverviewPage(); }
    if (value.version !== version || value.queryHash !== queryHash) throw new OverviewChanged();
    offset = value.offset;
  }
  const range = presetRange(query.preset, today, rows.filter(row => row.currency === profile.currency));
  // Keep the established expense/income stable tie ordering of the Overview table.
  const candidates = [...inRows(rows, range, profile.currency, "expense"), ...inRows(rows, range, profile.currency, "income")];
  const filtered = filterOverviewTransactions(candidates, { ...query.filters, category: query.category ?? query.filters.category });
  if (offset > filtered.length) throw new OverviewChanged();
  const page = filtered.slice(offset, offset + OVERVIEW_PAGE_SIZE);
  return {
    rows: withLedgerReceipts(page, accounting.state, profile.profileId), total: filtered.length, version, queryKey,
    categories: [...new Set(candidates.map(row => row.category))].sort(),
    nextCursor: offset + page.length < filtered.length ? Buffer.from(JSON.stringify({ offset: offset + page.length, version, queryHash })).toString("base64url") : null,
  };
}

export async function loadOverview(profile: UserProfile, settings: StudioSettings, query: OverviewTransactionQuery) {
  const { ledger, accounting } = await loadLedgerSnapshot(profile, settings, { receipts: false });
  const summary = buildOverviewSummary(ledger), firstPage = overviewTransactionPage(profile, accounting, ledger.rows, ledger.today, query);
  // Complete rows stay on the server. Detail rows cross the boundary once in firstPage.
  return { ledger: { ...ledger, rows: [] }, summary, firstPage };
}

/** Full source-coherent accounting precedes filtering/pagination; never page raw inputs or mutate state. */
export async function loadOverviewTransactionPage(profile: UserProfile, settings: StudioSettings, query: OverviewTransactionQuery, cursor: string | null) {
  const accounting = await loadAccountingReadModel(settings.supabase, profile.profileId);
  const transactions = accounting.availability === "ready" ? projectAccountingTransactions(accounting.rawTransactions, accounting.state) : accounting.rawTransactions;
  return overviewTransactionPage(profile, accounting, toLedgerRows(transactions), zonedYmd(new Date(), profile.timezone), query, cursor);
}
