import type { BankMessage, BankStore } from "@/lib/bank/store";
import type { UserProfile } from "@/lib/config";
import { normalizeCategory } from "@/lib/finance/categories";
import { loanBalances, type LoanStore } from "@/lib/finance/loans";
import { formatAmount, formatMinor, toMinor } from "@/lib/finance/money";
import type { LookupQuery } from "@/lib/finance/schemas";
import type { FinanceStore } from "@/lib/finance/store";
import type { InvestmentStore } from "@/lib/investments/store";
import type { NotebookStore } from "@/lib/notebook/store";
import type { PeopleStore } from "@/lib/people/store";

/** What the lookups read. Every read is scoped to the one person asking. */
export type LookupDeps = {
  store: FinanceStore;
  bank?: BankStore | null;
  loans?: LoanStore | null;
  investments?: InvestmentStore | null;
  notebook?: NotebookStore | null;
  people?: PeopleStore | null;
};

/** At most this many records per lookup reach the model; totals still cover every match. */
const SHOWN = 15;

const STATUS: Record<string, string> = {
  needs_label: "waiting for a label", recorded: "filed", matched: "matched", transfer: "own money", loan: "loan",
  skipped: "left out", lent: "lent", repaid: "repaid", borrowed: "borrowed", paid_back: "paid back", invested: "invested",
  not_completed: "not completed", returned: "returned",
};

const words = (value: string | null | undefined) => (value ?? "").toLowerCase().trim();
const inRange = (day: string, query: LookupQuery) => (!query.from || day >= query.from) && (!query.to || day <= query.to);

/** Runs the model's lookups for one person and describes the results in plain lines. */
export function createLookup(deps: LookupDeps, profile: UserProfile) {
  const owner = profile.profileId;
  return async (queries: LookupQuery[]): Promise<{ query: string; lines: string[] }[]> =>
    Promise.all(queries.map(async (query) => ({ query: describe(query), lines: await run(query) })));

  async function run(query: LookupQuery): Promise<string[]> {
    const text = words(query.text);
    if (query.tool === "transactions") {
      const category = query.category ? normalizeCategory(query.category, query.type ?? "expense") ?? query.category : null;
      const rows = (await deps.store.listTransactions(owner))
        .filter((row) => row.userId === owner && row.status === "active" && inRange(row.transactionDate, query)
          && (!query.type || row.type === query.type) && (!category || row.category === category)
          && (!text || `${row.description} ${row.category} ${row.notes}`.toLowerCase().includes(text)))
        .sort((left, right) => right.transactionDate.localeCompare(left.transactionDate));
      const totals = new Map<string, number>();
      for (const row of rows) totals.set(`${row.type} ${row.currency}`, (totals.get(`${row.type} ${row.currency}`) ?? 0) + toMinor(row.amount));
      return [
        `${rows.length} matching ${rows.length === 1 ? "transaction" : "transactions"}${rows.length > SHOWN ? `, newest ${SHOWN} shown` : ""}.`,
        ...[...totals].map(([key, minor]) => { const [type, currency] = key.split(" "); return `Total ${type}: ${formatMinor(minor, currency)}`; }),
        ...rows.slice(0, SHOWN).map((row) => `${row.transactionDate} · ${row.type} · ${formatAmount(row.amount, row.currency)} · ${row.category} · ${row.description}`),
      ];
    }
    if (query.tool === "bank_payments") {
      if (!deps.bank) return ["Bank texts aren't available."];
      const rows = (await deps.bank.listMessages(owner))
        .filter((row: BankMessage) => row.ownerId === owner && inRange(row.occurredAt.slice(0, 10), query) && (!text || row.counterparty.toLowerCase().includes(text)))
        .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
      return [`${rows.length} matching bank ${rows.length === 1 ? "payment" : "payments"}${rows.length > SHOWN ? `, newest ${SHOWN} shown` : ""}.`,
        ...rows.slice(0, SHOWN).map((row) => `${row.occurredAt.slice(0, 16).replace("T", " ")} · ${row.direction === "in" ? "IN" : "OUT"} · ${formatAmount(row.amount, row.currency)} · ${row.counterparty || "(no name)"} · ${STATUS[row.status] ?? row.status}`)];
    }
    if (query.tool === "loans") {
      if (!deps.loans) return ["Loans aren't available."];
      const person = words(query.person ?? query.text);
      const balances = loanBalances(await deps.loans.list(owner)).filter((item) => !person || item.person.toLowerCase().includes(person));
      if (balances.length === 0) return ["No loans recorded with anyone matching that."];
      return balances.map((item) => `${item.person}: owes you ${formatAmount(item.owed, item.currency)}; you owe them ${formatAmount(item.owe, item.currency)}`);
    }
    if (query.tool === "investments") {
      if (!deps.investments) return ["Investments aren't available."];
      const [list, values] = await Promise.all([deps.investments.list(owner), deps.investments.latestValues(owner)]);
      const shown = list.filter((item) => !text || item.name.toLowerCase().includes(text));
      if (shown.length === 0) return ["No investments matching that."];
      return shown.map((item) => {
        const value = values.filter((entry) => entry.investmentId === item.id).sort((left, right) => right.asOf.localeCompare(left.asOf))[0];
        return `${item.name} (${item.kind}, ${item.currency}): ${formatAmount(item.investedBefore, item.currency)} put in before tracking${value ? `; latest value ${formatAmount(value.value, item.currency)} on ${value.asOf.slice(0, 10)}` : ""}`;
      });
    }
    const [about, people] = await Promise.all([deps.notebook?.list(owner) ?? [], deps.people?.list(owner) ?? []]);
    const lines = [...about.map((item) => item.note), ...people.map((item) => `${item.name}: ${item.note}`)].filter((line) => !text || line.toLowerCase().includes(text));
    return lines.length ? lines.slice(0, SHOWN) : ["No notes matching that."];
  }
}

function describe(query: LookupQuery): string {
  const parts = [query.tool, query.text && `"${query.text}"`, query.person && `person ${query.person}`, query.category && `category ${query.category}`, query.type, (query.from || query.to) && `${query.from ?? "…"} to ${query.to ?? "…"}`];
  return parts.filter(Boolean).join(", ");
}
