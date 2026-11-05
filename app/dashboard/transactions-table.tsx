"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { buttonClassName } from "@/app/components/button-styles";
import { isAccountingRow } from "@/app/dashboard/accounting-row-action";
import { Spinner } from "@/app/components/status";
import { Select } from "@/app/components/select";
import { TemporalInput } from "@/app/components/temporal-input";
import { Button, Card, ConfirmDialog, Dialog, DialogActions, EmptyState, Field, inputClass, sendJson } from "@/app/components/ui";
import type { LedgerRow } from "@/lib/finance/analytics";
import { categoryList } from "@/lib/finance/categories";
import { useCustomCategories } from "@/app/components/category-catalog";
import { formatDisplayDate } from "@/lib/finance/dates";
import type { DateRange } from "@/lib/finance/dates";
import { formatMinor } from "@/lib/finance/money";
import { toMinor } from "@/lib/finance/money";
import type { TransactionRecord } from "@/lib/finance/types";
import { activityHref, overviewTransactionSearch, parseOverviewTransactionFilters, type OverviewTransactionFilters } from "@/lib/web/activity-handoff";
import { prepareTransactionEdit, type TransactionEditReview } from "./transaction-edit-review";

import "./transactions-table.css";

const PAGE = 15;
const MOBILE_RECENT = 6;

type Sort = "date-desc" | "date-asc" | "amount-desc" | "amount-asc";
type TransactionFilters = OverviewTransactionFilters;
const clearFilters: TransactionFilters = { search: "", type: "all", category: "all", sort: "date-desc" };

export function filterOverviewTransactions(rows: LedgerRow[], filters: TransactionFilters): LedgerRow[] {
  const needle = filters.search.trim().toLowerCase();
  const list = rows.filter((row) =>
    (filters.type === "all" || row.type === filters.type) &&
    (filters.category === "all" || row.category === filters.category) &&
    (!needle || row.description.toLowerCase().includes(needle) || row.category.toLowerCase().includes(needle)),
  );
  return [...list].sort((left, right) => {
    if (filters.sort === "amount-desc") return right.minor - left.minor;
    if (filters.sort === "amount-asc") return left.minor - right.minor;
    const byDate = left.date.localeCompare(right.date);
    return filters.sort === "date-asc" ? byDate : -byDate;
  });
}

export function TransactionsTable({
  rows,
  category,
  onClearCategory,
  rangeLabel,
  timeZone = "UTC",
  range,
  currency,
  initialFilters = clearFilters,
}: {
  rows: LedgerRow[];
  category: string | null;
  onClearCategory: () => void;
  rangeLabel: string;
  timeZone?: string;
  range?: DateRange;
  currency?: string;
  initialFilters?: OverviewTransactionFilters;
}) {
  const router = useRouter();
  const [search, setSearch] = useState(initialFilters.search);
  const [type, setType] = useState<"all" | "expense" | "income">(initialFilters.type);
  const [categoryFilter, setCategoryFilter] = useState(initialFilters.category);
  const [sort, setSort] = useState<Sort>(initialFilters.sort);
  const [shown, setShown] = useState(PAGE);
  const [editing, setEditing] = useState<LedgerRow | null>(null);
  const [deleting, setDeleting] = useState<LedgerRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [draftFilters, setDraftFilters] = useState<TransactionFilters>({ ...clearFilters });
  const [details, setDetails] = useState<LedgerRow | null>(null);
  const [notice, setNotice] = useState("");
  const [savedEntry, setSavedEntry] = useState<LedgerRow | null>(null);
  const [savedReview, setSavedReview] = useState<TransactionEditReview | null>(null);
  const removing = useRef(false);

  useEffect(() => {
    const restore = () => {
      const next = parseOverviewTransactionFilters(window.location.search);
      setSearch(next.search); setType(next.type); setCategoryFilter(next.category); setSort(next.sort); setShown(PAGE); setFiltersOpen(false);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  const activeCategory = category ?? (categoryFilter === "all" ? null : categoryFilter);
  const categories = useMemo(() => [...new Set(rows.map((row) => row.category))].sort(), [rows]);

  const filtered = useMemo(() => filterOverviewTransactions(rows, { search, type, category: activeCategory ?? "all", sort }), [rows, type, activeCategory, search, sort]);
  const activeFilterCount = Number(Boolean(search.trim())) + Number(type !== "all") + Number(Boolean(activeCategory)) + Number(sort !== "date-desc");

  function openFilters() {
    setDraftFilters({ search, type, category: activeCategory ?? "all", sort });
    setFiltersOpen(true);
  }

  function commitFilters(next: TransactionFilters) {
    setSearch(next.search); setType(next.type); setSort(next.sort); setCategoryFilter(next.category);
    const query = overviewTransactionSearch(window.location.search, next);
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    if (category && next.category !== category) onClearCategory();
    setShown(PAGE);
    setFiltersOpen(false);
  }
  function applyFilters() { commitFilters(draftFilters); }

  const allHref = activityHref({ start: range?.start, end: range?.end, currency: currency ?? rows[0]?.currency, category: activeCategory ?? "", search, type, sort });

  async function remove() {
    if (!deleting || removing.current) return;
    removing.current = true;
    setBusy(true);
    setError("");
    try {
      await sendJson("/api/transactions", "DELETE", { transactionId: deleting.id });
      setSavedEntry(null);
      setSavedReview(null);
      setNotice(`Removed ${deleting.description} on ${formatDisplayDate(deleting.date)}.`);
      setDeleting(null);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That transaction could not be removed.");
    } finally {
      removing.current = false;
      setBusy(false);
    }
  }

  return (
    <Card
      className="alfred-transactions"
      title={
        <span>
          Transactions <span className="font-normal text-muted">· {rangeLabel}</span>
        </span>
      }
      action={<div className="alfred-transaction-headerActions"><Button size="sm" className="alfred-button--compact alfred-transaction-filterToggle" onClick={openFilters} aria-label={activeFilterCount ? `Filters, ${activeFilterCount} active` : "Filters"} aria-haspopup="dialog"><FilterIcon />Filters{activeFilterCount ? <span className="alfred-transaction-filterCount">{activeFilterCount}</span> : null}</Button><Link href={allHref} aria-label="View all transactions" className={buttonClassName({ variant: "primary", size: "sm", className: "alfred-transaction-viewAll" })}><span className="alfred-transaction-viewAllLabel" aria-hidden="true">View all transactions</span><span className="alfred-transaction-viewAllShort" aria-hidden="true">View all</span></Link></div>}
    >

      {activeFilterCount ? <div className="alfred-transaction-filterChips" aria-label="Active transaction filters">
        {search.trim() ? <button type="button" onClick={() => commitFilters({ search: "", type, category: activeCategory ?? "all", sort })} aria-label={`Remove search filter ${search}`}>Search: {search}<span aria-hidden="true">×</span></button> : null}
        {activeCategory ? <button type="button" onClick={() => commitFilters({ search, type, category: "all", sort })} aria-label={`Remove category filter ${activeCategory}`}>{activeCategory}<span aria-hidden="true">×</span></button> : null}
        {type !== "all" ? <button type="button" onClick={() => commitFilters({ search, type: "all", category: activeCategory ?? "all", sort })} aria-label="Remove type filter">{type === "income" ? "Income" : "Expenses"}<span aria-hidden="true">×</span></button> : null}
        {sort !== "date-desc" ? <button type="button" onClick={() => commitFilters({ search, type, category: activeCategory ?? "all", sort: "date-desc" })} aria-label="Reset transaction sort">{sort === "date-asc" ? "Oldest first" : sort === "amount-desc" ? "Largest first" : "Smallest first"}<span aria-hidden="true">×</span></button> : null}
      </div> : null}
      {notice ? <div className="alfred-transaction-saveNotice"><p role="status">{notice}</p>{savedEntry ? <Button size="sm" onClick={() => setDetails(savedEntry)}>View entry</Button> : null}{savedReview ? <TransactionChanges review={savedReview} /> : null}</div> : null}

      {error ? (
        <p className="mt-3 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-4">
        {filtered.length === 0 ? (
          <EmptyState>No transactions match.</EmptyState>
        ) : (
          <>
            <table className="hidden w-full text-sm md:table">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="py-2 pr-3 font-normal">Date</th>
                  <th className="py-2 pr-3 font-normal">Description</th>
                  <th className="py-2 pr-3 font-normal">Category</th>
                  <th className="py-2 pr-3 text-right font-normal">Amount</th>
                  <th className="py-2 text-right font-normal">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, shown).map((row) => (
                  <tr key={row.id} className="border-b border-line last:border-0">
                    <td className="whitespace-nowrap py-3 pr-3 text-muted">
                      <time dateTime={row.receipt?.occurredAt ?? row.date}>
                        <span className="alfred-transaction-date">{transactionDate(row, timeZone)}</span>
                        <span className="alfred-transaction-time">{transactionTime(row, timeZone)}</span>
                      </time>
                    </td>
                    <td className="py-3 pr-3"><button type="button" className="alfred-transaction-desktopDescription" onClick={() => setDetails(row)} aria-label={`Open transaction ${row.description}`} aria-haspopup="dialog"><TransactionDirectionIcon row={row} /><span>{row.description}</span></button></td>
                    <td className="py-3 pr-3 text-muted">{row.category}</td>
                    <td className={`alfred-transaction-desktopAmount is-${transactionDirection(row)} whitespace-nowrap py-3 pr-3 text-right tabular-nums`}>
                      {transactionDirection(row) === "in" ? "+" : "−"}{formatMinor(Math.abs(row.minor), row.currency)}
                    </td>
                    <td className="whitespace-nowrap py-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => setDetails(row)} aria-label={`View details for ${row.description}`} aria-haspopup="dialog">Details</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <ul className="alfred-transaction-mobileList" aria-label="Recent transactions">
              {filtered.slice(0, MOBILE_RECENT).map((row) => <li key={row.id}>
                <button type="button" className="alfred-transaction-row" onClick={() => setDetails(row)} aria-label={`View details for ${row.description}`} aria-haspopup="dialog"><TransactionRowContent row={row} /></button>
              </li>)}
            </ul>

            <div className="alfred-transaction-desktopPagination mt-4 items-center justify-between text-xs text-muted">
              <span>
                Showing {Math.min(shown, filtered.length)} of {filtered.length}
              </span>
              {shown < filtered.length ? (
                <Button size="sm" onClick={() => setShown((count) => count + PAGE)}>
                  Show more
                </Button>
              ) : null}
            </div>
          </>
        )}
      </div>

      <div className="alfred-transaction-footer">
        <span className="alfred-transaction-mobileCount">{filtered.length > MOBILE_RECENT ? `${MOBILE_RECENT} of ${filtered.length}` : `${filtered.length} ${filtered.length === 1 ? "transaction" : "transactions"}`}</span>
      </div>

      <Dialog open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Filter transactions">
        <form className="alfred-transaction-filterSheet" onSubmit={(event) => { event.preventDefault(); applyFilters(); }}>
          <Field label="Search"><input className={inputClass} value={draftFilters.search} placeholder="Description or category" onChange={(event) => setDraftFilters((previous) => ({ ...previous, search: event.target.value }))} /></Field>
          <Field label="Type"><Select className={inputClass} value={draftFilters.type} onChange={(event) => setDraftFilters((previous) => ({ ...previous, type: event.target.value as TransactionFilters["type"] }))}><option value="all">All types</option><option value="expense">Expenses</option><option value="income">Income</option></Select></Field>
          <Field label="Category"><Select className={inputClass} value={draftFilters.category} onChange={(event) => setDraftFilters((previous) => ({ ...previous, category: event.target.value }))}><option value="all">All categories</option>{categories.map((item) => <option key={item} value={item}>{item}</option>)}</Select></Field>
          <Field label="Sort"><Select className={inputClass} value={draftFilters.sort} onChange={(event) => setDraftFilters((previous) => ({ ...previous, sort: event.target.value as Sort }))}><option value="date-desc">Newest first</option><option value="date-asc">Oldest first</option><option value="amount-desc">Largest first</option><option value="amount-asc">Smallest first</option></Select></Field>
          <div className="alfred-transaction-filterSheetActions alfred-buttonGroup--mobileStack"><Button variant="ghost" onClick={() => setDraftFilters({ ...clearFilters })}>Reset filters</Button><Button type="submit" variant="primary">Apply filters</Button></div>
        </form>
      </Dialog>

      <Dialog open={Boolean(details)} onClose={() => setDetails(null)} title="Transaction details">
        {details ? <TransactionReceipt row={details} timeZone={timeZone} onEdit={() => { setEditing(details); setDetails(null); }} onDelete={() => { setDeleting(details); setDetails(null); }} /> : null}
      </Dialog>

      {editing ? (
        <EditDialog
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={(updated, changes) => {
            setEditing(null);
            setSavedEntry(updated);
            setSavedReview(changes);
            setNotice(`Saved changes to ${updated.description} on ${formatDisplayDate(updated.date)}.`);
            router.refresh();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(deleting)}
        title="Delete this transaction?"
        body={
          deleting ? (
            <>
              {deleting.description}, <span className="amount">{formatMinor(deleting.minor, deleting.currency)}</span> on {formatDisplayDate(deleting.date)}. It
              will be removed from your totals on the website and in Telegram.
            </>
          ) : null
        }
        confirmLabel="Delete"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onClose={() => setDeleting(null)}
      />
    </Card>
  );
}

function FilterIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 17h16M8 4v6M16 14v6" /></svg>;
}

function transactionTime(row: LedgerRow, timeZone: string): string {
  const at = row.receipt?.occurredAt;
  if (!at || !Number.isFinite(Date.parse(at))) return "Time not recorded";
  const options = { hour: "2-digit", minute: "2-digit", timeZoneName: "short" } as const;
  try { return new Intl.DateTimeFormat("en-GB", { ...options, timeZone }).format(new Date(at)); }
  catch { return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" }).format(new Date(at)); }
}

function transactionDate(row: LedgerRow, timeZone: string): string {
  const at = row.receipt?.occurredAt;
  if (!at || !Number.isFinite(Date.parse(at))) return formatDisplayDate(row.date);
  const options = { day: "numeric", month: "short", year: "numeric" } as const;
  try { return new Intl.DateTimeFormat("en-GB", { ...options, timeZone }).format(new Date(at)); }
  catch { return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" }).format(new Date(at)); }
}

export function transactionDirection(row: Pick<LedgerRow, "type" | "minor">): "in" | "out" {
  return (row.type === "income" ? row.minor >= 0 : row.minor < 0) ? "in" : "out";
}

function TransactionDirectionIcon({ row }: { row: LedgerRow }) {
  const incoming = transactionDirection(row) === "in";
  return <span className={`alfred-transaction-direction is-${incoming ? "in" : "out"}`} aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{incoming ? <path d="M17 7 7 17M7 7v10h10" /> : <path d="M7 17 17 7M7 7h10v10" />}</svg></span>;
}

export function TransactionReceipt({ row, timeZone = "UTC", onEdit, onDelete }: { row: LedgerRow; timeZone?: string; onEdit?: () => void; onDelete?: () => void }) {
  const receipt = row.receipt;
  const incoming = transactionDirection(row) === "in";
  const kind = receipt?.kind ?? (/^accounting-fee:/.test(row.id) ? "fee" : /^accounting-tax:/.test(row.id) ? "tax" : "payment");
  const direction = incoming ? "Money in" : "Money out";
  const status = receipt ? ({ confirmed: "Confirmed", review: "Needs review", hold: "On hold", transfer: "Own-account transfer", duplicate: "Duplicate", excluded: "Excluded" } as const)[receipt.status] : null;
  const reportedAmountDiffers = receipt && kind === "payment" && Math.abs(row.minor) !== receipt.principalMinor;
  const amount = (minor: number) => <span className="tabular-nums">{formatMinor(minor, row.currency)}</span>;
  return <div className="alfred-transaction-receipt">
    <header className={`alfred-transaction-receiptHero is-${incoming ? "in" : "out"}`}>
      <span>{direction}{kind === "fee" ? " · Fee" : kind === "tax" ? " · Tax" : row.minor < 0 ? " · Adjustment" : ""}</span>
      <strong className="tabular-nums">{incoming ? "+" : "−"}{formatMinor(Math.abs(row.minor), row.currency)}</strong>
      <h3>{row.description}</h3>
      <p>{transactionDate(row, timeZone)} · {transactionTime(row, timeZone)}</p>
    </header>
    <dl className="alfred-transaction-receiptFacts">
      <div><dt>{receipt ? "Account" : "Payment method"}</dt><dd>{receipt ? receipt.accountLabel ?? "Unassigned" : row.paymentMethod}</dd></div>
      <div><dt>Category</dt><dd>{row.category || "Uncategorised"}</dd></div>
      {transactionDate(row, timeZone) !== formatDisplayDate(row.date) ? <div><dt>Report date</dt><dd>{formatDisplayDate(row.date)}</dd></div> : null}
      {status ? <div><dt>{kind === "payment" ? "Status" : "Payment status"}</dt><dd>{status}</dd></div> : null}
      {receipt?.sourceLabel ? <div><dt>Source</dt><dd>{receipt.sourceLabel}{receipt.imported ? " · Imported record" : ""}</dd></div> : null}
      {receipt && (kind !== "payment" || reportedAmountDiffers) ? <div><dt>Original payment</dt><dd>{amount(receipt.principalMinor)}</dd></div> : null}
      {receipt && kind === "payment" && receipt.feeMinor > 0 ? <div><dt>Separate fee</dt><dd>{amount(receipt.feeMinor)}</dd></div> : null}
      {receipt && kind === "payment" && receipt.taxMinor > 0 ? <div><dt>Separate tax</dt><dd>{amount(receipt.taxMinor)}</dd></div> : null}
      {receipt?.balanceBeforeMinor != null ? <div><dt>Reported balance before</dt><dd>{amount(receipt.balanceBeforeMinor)}</dd></div> : null}
      {receipt?.balanceAfterMinor != null ? <div><dt>Reported balance after</dt><dd>{amount(receipt.balanceAfterMinor)}</dd></div> : null}
      {receipt?.links.length ? <div><dt>Saved links</dt><dd>{receipt.links.map((link) => ({ transfer: "Own-account transfer", refund: "Refund", loan: "Loan" })[link]).join(", ")}</dd></div> : null}
    </dl>
    {kind === "fee" || kind === "tax" ? <p className="alfred-transaction-receiptNote">This is the {kind} recorded separately from the original payment.</p> : reportedAmountDiffers ? <p className="alfred-transaction-receiptNote">The amount above is the part counted in this report after linked refunds or repayments. The original payment is shown separately.</p> : null}
    {receipt?.sourceMissing ? <p className="alfred-transaction-receiptNote" role="status">The original source is no longer available. These are the retained record details.</p> : null}
    {isAccountingRow(row.id) ? <p className="alfred-transaction-receiptNote">This record is managed with its source payment and any linked transfers, refunds or loans.</p> : <div className="alfred-transaction-receiptActions alfred-buttonGroup--mobileStack">
      {onEdit ? <Button onClick={onEdit}>Edit transaction</Button> : null}
      {onDelete ? <Button variant="danger" onClick={onDelete}>Delete transaction</Button> : null}
    </div>}
  </div>;
}

function TransactionRowContent({ row }: { row: LedgerRow }) {
  const incoming = transactionDirection(row) === "in";
  return <>
    <TransactionDirectionIcon row={row} />
    <span className="alfred-transaction-description"><span className="alfred-transaction-name">{row.description}</span><span className="alfred-transaction-meta"><span>{row.category}</span><time dateTime={row.date}>{formatDisplayDate(row.date)}</time></span></span>
    <span className={`alfred-transaction-amount is-${incoming ? "in" : "out"}`}><span className="tabular-nums">{incoming ? "+" : "−"}{formatMinor(Math.abs(row.minor), row.currency)}</span><span>{row.minor < 0 ? "Adjustment" : row.type === "income" ? "Money in" : "Money out"}</span></span>
    <svg className="alfred-transaction-rowChevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
  </>;
}

function TransactionChanges({ review }: { review: TransactionEditReview }) {
  return <dl className="alfred-transaction-changes">{review.differences.map(change => {
    const monetary = change.label === "Payment amount" || change.label === "Separate fee";
    return <div key={change.label}><dt>{change.label}</dt><dd><span className={monetary ? "amount tabular-nums" : undefined}>{change.before}</span><span aria-hidden="true">→</span><strong className={monetary ? "amount tabular-nums" : undefined}>{change.after}</strong></dd></div>;
  })}</dl>;
}

function EditDialog({ row, onClose, onSaved }: { row: LedgerRow; onClose: () => void; onSaved: (updated: LedgerRow, review: TransactionEditReview) => void }) {
  const custom = useCustomCategories();
  const [type, setType] = useState(row.type);
  const [amount, setAmount] = useState(row.amount);
  const [description, setDescription] = useState(row.description);
  const [category, setCategory] = useState(row.category);
  const [date, setDate] = useState(row.date);
  const [includedFee, setIncludedFee] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [review, setReview] = useState<TransactionEditReview | null>(null);
  const saving = useRef(false);
  const options: readonly string[] = categoryList(type, custom);

  function close() { if (!saving.current) onClose(); }
  function prepare() {
    const result = prepareTransactionEdit(row, { type, amount, description, category, date, includedFee }, custom);
    if (!result.ok) { setError(result.error); return; }
    if (!Object.keys(result.review.changes).length) { onClose(); return; }
    setError(""); setReview(result.review);
  }
  async function save() {
    if (!review || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await sendJson<{ transaction: TransactionRecord }>("/api/transactions", "PATCH", { transactionId: row.id, changes: review.changes });
      const transaction = result.transaction;
      if (!transaction || transaction.transactionId !== row.id || transaction.status !== "active") throw new Error("The save could not be verified. Refresh your records before trying again.");
      onSaved({ ...row, amount: transaction.amount, minor: toMinor(transaction.amount), type: transaction.type, description: transaction.description, category: transaction.category, date: transaction.transactionDate, currency: transaction.currency, paymentMethod: transaction.paymentMethod, receipt: undefined }, review);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That change could not be saved.");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={close} dismissible={!busy} title={review ? "Review transaction changes" : "Edit transaction"}>
      {review ? <div className="alfred-transaction-changeReview">
        <p><strong>{row.description}</strong><br />{formatDisplayDate(row.date)} · <span className="amount tabular-nums">{formatMinor(Math.abs(row.minor), row.currency)}</span></p>
        <TransactionChanges review={review} />
        {review.splitsFee ? <p className="text-sm text-muted">The fee is split into its own Fees entry. Combined payment and fee: <span className="amount tabular-nums">{formatMinor(toMinor(review.changes.amount ?? row.amount), row.currency)}</span>.</p> : null}
        {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
        <DialogActions><Button onClick={() => { setReview(null); setError(""); }} disabled={busy}>Back</Button><Button variant="primary" onClick={() => void save()} disabled={busy} aria-busy={busy}>{busy ? <><Spinner />Saving…</> : "Save changes"}</Button></DialogActions>
      </div> : <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          prepare();
        }}
      >
        <Field label="Type">
          <Select
            className={inputClass}
            value={type}
            onChange={(event) => {
              const next = event.target.value as LedgerRow["type"];
              setType(next);
              const list: readonly string[] = categoryList(next, custom);
              if (!list.includes(category)) setCategory(list[0]);
            }}
          >
            <option value="expense">Expense</option>
            <option value="income">Income</option>
          </Select>
        </Field>
        <Field label={`Amount (${row.currency})`}>
          <input className={inputClass} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} required />
        </Field>
        <Field label="Description">
          <input className={inputClass} value={description} maxLength={200} onChange={(event) => setDescription(event.target.value)} required />
        </Field>
        <Field label="Category">
          <Select className={inputClass} value={category} onChange={(event) => setCategory(event.target.value)}>
            {options.includes(category) ? null : <option value={category}>{category}</option>}
            {options.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Date">
          <TemporalInput type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
        </Field>
        {type === "expense" && category !== "Fees" && row.minor > 0 ? (
          <Field
            label={`Split out included fee (${row.currency}, optional)`}
            hint="Splits this fee out into a separate Fees entry and lowers this payment by the same amount, keeping your total spend unchanged."
          >
            <input
              className={inputClass}
              inputMode="decimal"
              placeholder="e.g. 3.00"
              value={includedFee}
              onChange={(event) => setIncludedFee(event.target.value)}
            />
          </Field>
        ) : null}
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <DialogActions>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Review changes
          </Button>
        </DialogActions>
      </form>}
    </Dialog>
  );
}
