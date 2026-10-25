"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Spinner } from "@/app/components/status";
import { Button, Card, ConfirmDialog, Dialog, EmptyState, Field, inputClass, sendJson } from "@/app/components/ui";
import type { LedgerRow } from "@/lib/finance/analytics";
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from "@/lib/finance/categories";
import { formatDisplayDate } from "@/lib/finance/dates";
import { formatMinor } from "@/lib/finance/money";

const PAGE = 15;

type Sort = "date-desc" | "date-asc" | "amount-desc" | "amount-asc";

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

  const activeCategory = category ?? (categoryFilter === "all" ? null : categoryFilter);
  const categories = useMemo(() => [...new Set(rows.map((row) => row.category))].sort(), [rows]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = rows.filter(
      (row) =>
        (type === "all" || row.type === type) &&
        (!activeCategory || row.category === activeCategory) &&
        (!needle || row.description.toLowerCase().includes(needle) || row.category.toLowerCase().includes(needle)),
    );
    return [...list].sort((left, right) => {
      if (sort === "amount-desc") return right.minor - left.minor;
      if (sort === "amount-asc") return left.minor - right.minor;
      const byDate = left.date.localeCompare(right.date);
      return sort === "date-asc" ? byDate : -byDate;
    });
  }, [rows, type, activeCategory, search, sort]);

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
      title={
        <span>
          Transactions <span className="font-normal text-muted">· {rangeLabel}</span>
        </span>
      }
    >
      <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
        <label className="sr-only" htmlFor="tx-search">
          Search transactions
        </label>
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
        <select aria-label="Type" className={inputClass} value={type} onChange={(event) => setType(event.target.value as typeof type)}>
          <option value="all">All types</option>
          <option value="expense">Expenses</option>
          <option value="income">Income</option>
        </select>
        <select
          aria-label="Category"
          className={inputClass}
          value={category ?? categoryFilter}
          disabled={Boolean(category)}
          onChange={(event) => setCategoryFilter(event.target.value)}
        >
          <option value="all">All categories</option>
          {categories.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <select aria-label="Sort" className={inputClass} value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
          <option value="date-desc">Newest first</option>
          <option value="date-asc">Oldest first</option>
          <option value="amount-desc">Largest first</option>
          <option value="amount-asc">Smallest first</option>
        </select>
      </div>

      {category ? (
        <p className="mt-3 flex items-center gap-2 text-xs text-muted">
          Showing <span className="rounded-full bg-gold-soft px-2 py-0.5 text-gold">{category}</span>
          <button type="button" className="underline-offset-2 hover:text-ink hover:underline" onClick={onClearCategory}>
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
                    <td className="whitespace-nowrap py-2.5 pr-3 text-muted">{formatDisplayDate(row.date)}</td>
                    <td className="py-2.5 pr-3">{row.description}</td>
                    <td className="py-2.5 pr-3 text-muted">{row.category}</td>
                    <td className={`whitespace-nowrap py-2.5 pr-3 text-right tabular-nums ${row.type === "income" ? "text-success" : ""}`}>
                      {row.type === "income" ? "+" : ""}
                      {formatMinor(row.minor, row.currency)}
                    </td>
                    <td className="whitespace-nowrap py-2.5 text-right">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(row)} aria-label={`Edit ${row.description}`}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleting(row)} aria-label={`Delete ${row.description}`}>
                        Delete
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <ul className="flex flex-col gap-2 md:hidden">
              {filtered.slice(0, shown).map((row) => (
                <li key={row.id} className="rounded-xl border border-line bg-bg p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm">{row.description}</p>
                      <p className="mt-0.5 text-xs text-muted">
                        {row.category} · {formatDisplayDate(row.date)}
                      </p>
                    </div>
                    <p className={`shrink-0 text-sm tabular-nums ${row.type === "income" ? "text-success" : ""}`}>
                      {row.type === "income" ? "+" : ""}
                      {formatMinor(row.minor, row.currency)}
                    </p>
                  </div>
                  <div className="mt-2 flex justify-end gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(row)} aria-label={`Edit ${row.description}`}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(row)} aria-label={`Delete ${row.description}`}>
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>

            <div className="mt-4 flex items-center justify-between text-xs text-muted">
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

function EditDialog({ row, onClose, onSaved }: { row: LedgerRow; onClose: () => void; onSaved: () => void }) {
  const [type, setType] = useState(row.type);
  const [amount, setAmount] = useState(row.amount);
  const [description, setDescription] = useState(row.description);
  const [category, setCategory] = useState(row.category);
  const [date, setDate] = useState(row.date);
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
          <select
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
          </select>
        </Field>
        <Field label={`Amount (${row.currency})`}>
          <input className={inputClass} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} required />
        </Field>
        <Field label="Description">
          <input className={inputClass} value={description} maxLength={200} onChange={(event) => setDescription(event.target.value)} required />
        </Field>
        <Field label="Category">
          <select className={inputClass} value={category} onChange={(event) => setCategory(event.target.value)}>
            {options.includes(category) ? null : <option value={category}>{category}</option>}
            {options.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Date">
          <input className={inputClass} type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
        </Field>
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
