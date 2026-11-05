import type { accountBalances } from "./accounts";

type BalanceBasis = { availability: "ready" | "migration-required"; balances: ReturnType<typeof accountBalances> };

/** The same included, same-currency account snapshots used by Overview and Accounts. */
export type IncludedAccountCash = {
  availability: "ready" | "migration-required" | "unavailable";
  currency: string;
  totalMinor: number | null;
  knownSubtotalMinor: number | null;
  accountCount: number;
  count: number;
  missingCount: number;
  excludedCount: number;
  accounts: { id: string; label: string; balanceMinor: number | null; reportedAt: string | null }[];
  oldestReportedAt: string | null;
  latestReportedAt: string | null;
};

export function includedAccountCash(accounting: BalanceBasis | null | undefined, currency: string): IncludedAccountCash {
  const available = accounting?.availability === "ready" ? accounting.balances : null;
  const accounts = available?.accounts.filter(({ account }) => account.includeInCash && account.currency === currency).map(({ account, snapshot }) => ({
    id: account.id, label: account.label, balanceMinor: snapshot?.balanceMinor ?? null, reportedAt: snapshot?.occurredAt ?? null,
  })) ?? [];
  const reported = accounts.flatMap((account) => account.reportedAt ? [account.reportedAt] : []).sort((a, b) => Date.parse(a) - Date.parse(b));
  return {
    availability: accounting?.availability ?? "unavailable", currency,
    totalMinor: available?.totalMinor ?? null,
    knownSubtotalMinor: available?.knownSubtotalMinor ?? null,
    accountCount: available?.accounts.length ?? 0,
    count: available?.count ?? 0, missingCount: available?.missingCount ?? 0, excludedCount: available?.excludedCount ?? 0,
    accounts, oldestReportedAt: reported[0] ?? null, latestReportedAt: reported.at(-1) ?? null,
  };
}
