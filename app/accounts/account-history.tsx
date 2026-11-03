"use client";

import { useMemo, useState } from "react";
import { buttonClassName } from "@/app/components/button-styles";
import type { AccountingState, FinancialAccount } from "@/lib/finance/accounting/types";

export const ACCOUNT_PAGE_SIZE = 25;
const accountTime = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Accra", timeZoneName: "short" });
export function formatAccountTime(value: string | null) {
  if (!value) return "Time not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : accountTime.format(parsed);
}

/** Display windows only; the complete source arrays remain available to accounting actions. */
export function accountListPage<T>(rows: readonly T[], requestedPage: number) {
  const pageCount = Math.max(1, Math.ceil(rows.length / ACCOUNT_PAGE_SIZE));
  const page = Math.max(0, Math.min(Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 0, pageCount - 1));
  const offset = page * ACCOUNT_PAGE_SIZE;
  return { rows: rows.slice(offset, offset + ACCOUNT_PAGE_SIZE), page, pageCount, total: rows.length, start: rows.length ? offset + 1 : 0, end: Math.min(offset + ACCOUNT_PAGE_SIZE, rows.length) };
}

export function AccountPageControls({ page, pageCount, start, end, total, label, onPage }: Omit<ReturnType<typeof accountListPage>, "rows"> & { label: string; onPage: (page: number) => void }) {
  if (pageCount === 1) return null;
  return <nav className="alfred-accounts-pagination" aria-label={`${label} pages`}>
    <p role="status">{start}–{end} of {total} {label.toLowerCase()}</p>
    <div><button type="button" className={buttonClassName({ variant: "secondary", size: "sm" })} disabled={page === 0} onClick={() => onPage(page - 1)} aria-label={`Previous ${label.toLowerCase()} page`}>Previous</button><button type="button" className={buttonClassName({ variant: "secondary", size: "sm" })} disabled={page + 1 >= pageCount} onClick={() => onPage(page + 1)} aria-label={`Next ${label.toLowerCase()} page`}>Next</button></div>
  </nav>;
}

export function BalanceHistory({ snapshots, account, money }: { snapshots: AccountingState["snapshots"]; account: FinancialAccount; money: (value: number, currency: string) => string }) {
  const [open, setOpen] = useState(false);
  return <details className="alfred-account-evidence" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Balance history</summary>
    {open ? <BalanceHistoryContent snapshots={snapshots} account={account} money={money} /> : null}
  </details>;
}

function BalanceHistoryContent({ snapshots, account, money }: { snapshots: AccountingState["snapshots"]; account: FinancialAccount; money: (value: number, currency: string) => string }) {
  const [page, setPage] = useState(0);
  const records = useMemo(() => snapshots.filter((item) => item.accountId === account.id).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id)), [snapshots, account.id]);
  const window = accountListPage(records, page);
  if (!records.length) return <p>No account-bound snapshots yet. Provider-only evidence is not assigned automatically.</p>;
  return <><dl>{window.rows.map((item) => <div key={item.id}><dt>{formatAccountTime(item.occurredAt)}</dt><dd>{money(item.balanceMinor, account.currency)}</dd></div>)}</dl><AccountPageControls {...window} label="Balances" onPage={setPage} /></>;
}
