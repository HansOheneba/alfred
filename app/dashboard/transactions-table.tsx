"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useMemo, useState } from "react";

import { buttonClassName } from "@/app/components/button-styles";
import { AccountingRowAction, isAccountingRow } from "@/app/dashboard/accounting-row-action";
import { Spinner } from "@/app/components/status";
import { Select } from "@/app/components/select";
import { Button, Card, ConfirmDialog, Dialog, EmptyState, Field, inputClass, sendJson } from "@/app/components/ui";
import type { LedgerRow } from "@/lib/finance/analytics";
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from "@/lib/finance/categories";
import { formatDisplayDate } from "@/lib/finance/dates";
import { formatMinor } from "@/lib/finance/money";

import "./transactions-table.css";

const PAGE = 15;
const MOBILE_RECENT = 6;

type Sort = "date-desc" | "date-asc" | "amount-desc" | "amount-asc";
type TransactionFilters = { search: string; type: "all" | "expense" | "income"; category: string; sort: Sort };
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
}: {
  rows: LedgerRow[];
  category: string | null;
  onClearCategory: () => void;
  rangeLabel: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [type, setType] = useState<"all" | "expense" | "income">("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [sort, setSort] = useState<Sort>("date-desc");
  const [shown, setShown] = useState(PAGE);
  const [editing, setEditing] = useState<LedgerRow | null>(null);
  const [deleting, setDeleting] = useState<LedgerRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [draftFilters, setDraftFilters] = useState<TransactionFilters>({ ...clearFilters });
  const [rowActions, setRowActions] = useState<LedgerRow | null>(null);

  const activeCategory = category ?? (categoryFilter === "all" ? null : categoryFilter);
  const categories = useMemo(() => [...new Set(rows.map((row) => row.category))].sort(), [rows]);

  const filtered = useMemo(() => filterOverviewTransactions(rows, { search, type, category: activeCategory ?? "all", sort }), [rows, type, activeCategory, search, sort]);
  const activeFilterCount = Number(Boolean(search.trim())) + Number(type !== "all") + Number(Boolean(activeCategory)) + Number(sort !== "date-desc");

  function openFilters() {
    setDraftFilters({ search, type, category: activeCategory ?? "all", sort });
    setFiltersOpen(true);
  }

  function applyFilters() {
    setSearch(draftFilters.search);
    setType(draftFilters.type);
    setSort(draftFilters.sort);
    setCategoryFilter(draftFilters.category);
    if (category && draftFilters.category !== category) onClearCategory();
    setShown(PAGE);
    setFiltersOpen(false);
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    setError("");
    try {
      await sendJson("/api/transactions", "DELETE", { transactionId: deleting.id });
      setDeleting(null);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That transaction could not be removed.");
    } finally {
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
      action={<Button size="sm" className="alfred-button--compact alfred-transaction-filterToggle" onClick={openFilters} aria-label={activeFilterCount ? `Filters, ${activeFilterCount} active` : "Filters"} aria-haspopup="dialog"><FilterIcon />Filters{activeFilterCount ? <span className="alfred-transaction-filterCount">{activeFilterCount}</span> : null}</Button>}
    >
      <div className="alfred-transaction-filters alfred-transaction-desktopFilters">
        <label className="alfred-transaction-field" htmlFor="tx-search">
          <span>Search transactions</span>
          <input
            id="tx-search"
            className={inputClass}
            placeholder="Search description or category"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setShown(PAGE);
            }}
          />
        </label>
        <label className="alfred-transaction-field" htmlFor="tx-type">
          <span>Type</span>
          <Select id="tx-type" aria-label="Type" className={inputClass} value={type} onChange={(event) => { setType(event.target.value as typeof type); setShown(PAGE); }}>
            <option value="all">All types</option>
            <option value="expense">Expenses</option>
            <option value="income">Income</option>
          </Select>
        </label>
        <label className="alfred-transaction-field" htmlFor="tx-category">
          <span>Category</span>
          <Select
            id="tx-category"
            aria-label="Category"
            className={inputClass}
            value={category ?? categoryFilter}
            disabled={Boolean(category)}
            onChange={(event) => { setCategoryFilter(event.target.value); setShown(PAGE); }}
          >
            <option value="all">All categories</option>
            {categories.map((item) => <option key={item} value={item}>{item}</option>)}
          </Select>
        </label>
        <label className="alfred-transaction-field" htmlFor="tx-sort">
          <span>Sort</span>
          <Select id="tx-sort" aria-label="Sort" className={inputClass} value={sort} onChange={(event) => { setSort(event.target.value as Sort); setShown(PAGE); }}>
            <option value="date-desc">Newest first</option>
            <option value="date-asc">Oldest first</option>
            <option value="amount-desc">Largest first</option>
            <option value="amount-asc">Smallest first</option>
          </Select>
        </label>
      </div>

      {category ? (
        <p className="mt-3 flex items-center gap-2 text-xs text-muted">
          Showing <span className="rounded-full bg-accent-soft px-2 py-1 text-accent">{category}</span>
          <button type="button" className={buttonClassName({ variant: "ghost", size: "sm" })} onClick={onClearCategory}>
            Clear
          </button>
        </p>
      ) : null}

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
                      <time dateTime={row.date} title="Only the transaction date was recorded">
                        <span className="alfred-transaction-date">{formatDisplayDate(row.date)}</span>
                        <span className="alfred-transaction-time">Time not recorded</span>
                      </time>
                    </td>
                    <td className="py-3 pr-3">{row.description}</td>
                    <td className="py-3 pr-3 text-muted">{row.category}</td>
                    <td className={`whitespace-nowrap py-3 pr-3 text-right tabular-nums ${row.type === "income" ? "text-income" : ""}`}>
                      {row.type === "income" ? "+" : ""}
                      {formatMinor(row.minor, row.currency)}
                    </td>
                    <td className="whitespace-nowrap py-3 text-right">
                      {isAccountingRow(row.id) ? <AccountingRowAction /> : <>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(row)} aria-label={`Edit ${row.description}`}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleting(row)} aria-label={`Delete ${row.description}`}>
                        Delete
                      </Button>
                      </>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <ul className="alfred-transaction-mobileList" aria-label="Recent transactions">
              {filtered.slice(0, MOBILE_RECENT).map((row) => <li key={row.id}>
                {isAccountingRow(row.id) ? <Link href="/accounts?tab=activity" className="alfred-transaction-row" aria-label={`View ${row.description} in account activity`}><TransactionRowContent row={row} /></Link>
                  : <button type="button" className="alfred-transaction-row" onClick={() => setRowActions(row)} aria-label={`Options for ${row.description}`} aria-haspopup="dialog"><TransactionRowContent row={row} /></button>}
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
        <Link href="/accounts?tab=activity" className={buttonClassName({ variant: "ghost", size: "sm", className: "alfred-transaction-viewAll" })}>View all transactions <span aria-hidden="true">↗</span></Link>
      </div>

      <Dialog open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Filter transactions">
        <form className="alfred-transaction-filterSheet" onSubmit={(event) => { event.preventDefault(); applyFilters(); }}>
          <Field label="Search"><input className={inputClass} value={draftFilters.search} placeholder="Description or category" onChange={(event) => setDraftFilters((previous) => ({ ...previous, search: event.target.value }))} /></Field>
          <Field label="Type"><Select className={inputClass} value={draftFilters.type} onChange={(event) => setDraftFilters((previous) => ({ ...previous, type: event.target.value as TransactionFilters["type"] }))}><option value="all">All types</option><option value="expense">Expenses</option><option value="income">Income</option></Select></Field>
          <Field label="Category"><Select className={inputClass} value={draftFilters.category} onChange={(event) => setDraftFilters((previous) => ({ ...previous, category: event.target.value }))}><option value="all">All categories</option>{categories.map((item) => <option key={item} value={item}>{item}</option>)}</Select></Field>
          <Field label="Sort"><Select className={inputClass} value={draftFilters.sort} onChange={(event) => setDraftFilters((previous) => ({ ...previous, sort: event.target.value as Sort }))}><option value="date-desc">Newest first</option><option value="date-asc">Oldest first</option><option value="amount-desc">Largest first</option><option value="amount-asc">Smallest first</option></Select></Field>
          <div className="alfred-transaction-filterSheetActions"><Button variant="ghost" onClick={() => setDraftFilters({ ...clearFilters })}>Reset filters</Button><Button type="submit" variant="primary">Apply filters</Button></div>
        </form>
      </Dialog>

      <Dialog open={Boolean(rowActions)} onClose={() => setRowActions(null)} title="Transaction options">
        {rowActions ? <div className="alfred-transaction-options">
          <p className="font-medium">{rowActions.description}</p>
          <p className="text-sm text-muted">{rowActions.category} · {formatDisplayDate(rowActions.date)}</p>
          <Button onClick={() => { setEditing(rowActions); setRowActions(null); }}>Edit transaction</Button>
          <Button variant="danger" onClick={() => { setDeleting(rowActions); setRowActions(null); }}>Delete transaction</Button>
        </div> : null}
      </Dialog>

      {editing ? (
        <EditDialog
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
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
              {deleting.description}, {formatMinor(deleting.minor, deleting.currency)} on {formatDisplayDate(deleting.date)}. It
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

function TransactionRowContent({ row }: { row: LedgerRow }) {
  const incoming = row.type === "income" ? row.minor >= 0 : row.minor < 0;
  return <>
    <span className={`alfred-transaction-direction is-${incoming ? "in" : "out"}`} aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{incoming ? <path d="M17 7 7 17M7 7v10h10" /> : <path d="M7 17 17 7M7 7h10v10" />}</svg></span>
    <span className="alfred-transaction-description"><span className="alfred-transaction-name">{row.description}</span><span className="alfred-transaction-meta"><span>{row.category}</span><time dateTime={row.date}>{formatDisplayDate(row.date)}</time></span></span>
    <span className={`alfred-transaction-amount is-${incoming ? "in" : "out"}`}><span className="tabular-nums">{incoming ? "+" : "−"}{formatMinor(Math.abs(row.minor), row.currency)}</span><span>{row.minor < 0 ? "Adjustment" : row.type === "income" ? "Money in" : "Money out"}</span></span>
    <svg className="alfred-transaction-rowChevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
  </>;
}

function EditDialog({ row, onClose, onSaved }: { row: LedgerRow; onClose: () => void; onSaved: () => void }) {
  const [type, setType] = useState(row.type);
  const [amount, setAmount] = useState(row.amount);
  const [description, setDescription] = useState(row.description);
  const [category, setCategory] = useState(row.category);
  const [date, setDate] = useState(row.date);
  const [includedFee, setIncludedFee] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const options: readonly string[] = type === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;

  async function save() {
    const changes: Record<string, string> = {};
    if (amount.trim() !== row.amount) changes.amount = amount.trim();
    if (description.trim() !== row.description) changes.description = description.trim();
    if (category !== row.category || type !== row.type) changes.category = category;
    if (date !== row.date) changes.date = date;
    if (type !== row.type) changes.transactionType = type;
    if (includedFee.trim()) changes.includedFee = includedFee.trim();
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setError("");
    try {
      await sendJson("/api/transactions", "PATCH", { transactionId: row.id, changes });
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That change could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="Edit transaction">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field label="Type">
          <Select
            className={inputClass}
            value={type}
            onChange={(event) => {
              const next = event.target.value as LedgerRow["type"];
              setType(next);
              const list: readonly string[] = next === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
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
          <input className={inputClass} type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
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
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy} aria-busy={busy} aria-label="Save changes">
            {busy ? <Spinner /> : "Save changes"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
