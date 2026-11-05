"use client";

import Link from "next/link";
import { buttonClassName } from "@/app/components/button-styles";
import { Button, Dialog } from "@/app/components/ui";
import { Select } from "@/app/components/select";
import { TemporalInput } from "@/app/components/temporal-input";
import { cloneElement, createContext, isValidElement, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { usePrivacyMask } from "@/app/components/app-shell";
import { buildAccountingView } from "@/lib/finance/accounting/view";
import type { SettlementIssue } from "@/lib/finance/accounting/settlements";
import { needsAttention, type AccountingAction, type AccountingState, type CashMovement, type FinancialAccount } from "@/lib/finance/accounting/types";
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from "@/lib/finance/categories";
import { formatMinor, toMinor } from "@/lib/finance/money";
import { AccountPageControls, accountListPage, BalanceHistory, formatAccountTime } from "./account-history";
import { parseActivityHandoff } from "@/lib/web/activity-handoff";
import { canUndoReceipt, emptyActivityFilters, executeAccountReview, filterActivityMovements, groupAttention, movementDayGroups, movementIsLinked, nextReviewMovement, prepareMovementReview, prepareSimilarReview, readableMovementDay, undoAccountReceipt, type AccountChangeReceipt, type AccountCommand, type AccountReview, type ActivityFilters } from "./activity-tools";
import "./accounts.css";

type Command = AccountCommand;
type Tab = "accounts" | "activity" | "settlements" | "subscriptions" | "needs-attention";
type Props = { state: AccountingState; dispatch: (action: AccountingAction) => Promise<unknown>; mode: "live" | "preview"; availability?: "ready" | "migration-required"; defaultCurrency?: string; now?: string; subscriptions?: ReactNode; onReset?: () => void; storageHint?: string; initialPaymentMovementId?: string; paymentUnavailable?: boolean };
const reference = (movement: CashMovement) => ({ movementId: movement.id, sourceFingerprint: movement.sourceFingerprint });
const AccountsError = createContext("");
const id = () => crypto.randomUUID();
export function resolveAccountWorkspaceTab(value: string | null): Tab { return ["activity", "settlements", "subscriptions", "needs-attention"].includes(value ?? "") ? value as Tab : "accounts"; }
export function accountWorkspaceHref(href: string, tab: Tab): string {
  const url = new URL(href, "https://alfred.invalid");
  if (tab === "accounts") url.searchParams.delete("tab"); else url.searchParams.set("tab", tab);
  return `${url.pathname}${url.search}${url.hash}`;
}
function browserTab(): Tab { return resolveAccountWorkspaceTab(new URLSearchParams(window.location.search).get("tab")); }
function browserSearch(): string { return window.location.search; }
function subscribeTab(callback: () => void) { window.addEventListener("popstate", callback); return () => window.removeEventListener("popstate", callback); }
const date = formatAccountTime;
function Glyph({ kind = "account" }: { kind?: "account" | "arrow" | "plus" }) { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind === "plus" ? <path d="M12 5v14M5 12h14" /> : kind === "arrow" ? <path d="m7 17 10-10M7 7h10v10" /> : <><rect x="3" y="5" width="18" height="15" rx="3" /><path d="M3 9h18M16 14h3M7 5V3h11" /></>}</svg>; }
function Field({ label, children }: { label: string; children: ReactNode }) {
  const labelId = useId();
  const control = isValidElement<{ "aria-label"?: string; "aria-labelledby"?: string }>(children) && (children.type === Select || children.type === TemporalInput) && !children.props["aria-label"] && !children.props["aria-labelledby"] ? cloneElement(children, { "aria-labelledby": labelId }) : children;
  return <label className="alfred-accounts-field"><span id={labelId}>{label}</span>{control}</label>;
}

export function AccountsWorkspace({ state, dispatch, mode, availability = "ready", defaultCurrency = "GHS", now, subscriptions, onReset, storageHint, initialPaymentMovementId, paymentUnavailable }: Props) {
  const [masked] = usePrivacyMask();
  const initialTab = useSyncExternalStore(subscribeTab, browserTab, () => "accounts" as Tab);
  const [chosenTab, setChosenTab] = useState<Tab | null>(initialPaymentMovementId || paymentUnavailable ? 'activity' : null);
  const tab = chosenTab ?? initialTab;
  const activityScope = tab === "accounts" ? "activity" : tab;
  const query = useSyncExternalStore(subscribeTab, browserSearch, () => "");
  const incomingFilters = useMemo(() => ({ ...emptyActivityFilters, ...parseActivityHandoff(query) }), [query]);
  // Internal tab/payment navigation must not discard the user's applied filters.
  const filterQuery = JSON.stringify(incomingFilters);
  useEffect(() => {
    const restoreTab = () => setChosenTab(null);
    window.addEventListener("popstate", restoreTab);
    return () => window.removeEventListener("popstate", restoreTab);
  }, []);
  function setTab(value: Tab) {
    setChosenTab(value);
    const href = accountWorkspaceHref(window.location.href, value);
    if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== href) window.history.pushState(window.history.state, "", href);
  }
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [accountEditor, setAccountEditor] = useState<FinancialAccount | "new" | null>(null);
  const [snapshotAccount, setSnapshotAccount] = useState<FinancialAccount | null>(null);
  const [movementId, setMovementId] = useState<string | null>(initialPaymentMovementId ?? null);
  const [filterEdits, setFilterEdits] = useState<{ query: string; value: ActivityFilters } | null>(null);
  const filters = filterEdits?.query === filterQuery ? filterEdits.value : incomingFilters;
  const { search, account: accountFilter, status: statusFilter } = filters;
  function changeFilters(changes: Partial<ActivityFilters>) { setFilterEdits({ query: filterQuery, value: { ...filters, ...changes } }); }
  const setSearch = (value: string) => changeFilters({ search: value });
  const setAccountFilter = (value: string) => changeFilters({ account: value });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [draftFilters, setDraftFilters] = useState<ActivityFilters>({ ...emptyActivityFilters });
  const activeFilterCount = Number(Boolean(search.trim())) + Number(Boolean(accountFilter)) + Number(Boolean(statusFilter)) + Number(Boolean(filters.start || filters.end)) + Number(Boolean(filters.category)) + Number(filters.type !== "all") + Number(Boolean(filters.currency)) + Number(filters.sort !== "date-desc");
  function openFilters() { setDraftFilters({ ...filters }); setFiltersOpen(true); }
  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draftFilters.start && draftFilters.end && draftFilters.start > draftFilters.end) return;
    setFilterEdits({ query: filterQuery, value: { ...draftFilters, search: draftFilters.search.trim() } }); setFiltersOpen(false);
  }
  const [receipt, setReceipt] = useState<AccountChangeReceipt | null>(null);
  const [saveProgress, setSaveProgress] = useState("");
  const [bulkGroup, setBulkGroup] = useState<CashMovement[] | null>(null);
  const [currency, setCurrency] = useState(defaultCurrency);
  useEffect(() => {
    if (availability !== "ready" || mode !== "live") return;
    let frame = 0;
    const openRequestedAccount = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const url = new URL(window.location.href);
        if (url.searchParams.get("add") !== "1") return;
        url.searchParams.delete("add");
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
        setAccountEditor("new");
      });
    };
    openRequestedAccount();
    window.addEventListener("popstate", openRequestedAccount);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("popstate", openRequestedAccount); };
  }, [availability, mode]);
  const view = useMemo(() => buildAccountingView(state, currency), [state, currency]);
  const firstUse = availability === "ready" && state.accounts.length === 0 && state.movements.length === 0;
  const hasFilters = activeFilterCount > 0;
  const attention = useMemo(() => state.movements.filter(needsAttention), [state.movements]);
  const attentionGroups = useMemo(() => groupAttention(attention).sort((a, b) => b.rows.length - a.rows.length), [attention]);
  const movement = state.movements.find((row) => row.id === movementId);
  const currencies = [...new Set([defaultCurrency, ...state.accounts.map((item) => item.currency)])];
  const money = (minor: number, unit = currency) => masked ? "••••••" : formatMinor(minor, unit);
  async function run(command: Command, success: string) {
    if (saving.current || availability !== "ready") return false;
    saving.current = true;
    setBusy(true); setNotice(null); setReceipt(null); setSaveProgress("Saving your change…");
    try { const result = await executeAccountReview({ ownerId: state.ownerId, revision: state.revision, commands: [command], movements: [] }, state, dispatch, id); if (!result.ok) throw new Error(result.error); setNotice({ text: success, error: false }); return true; }
    catch (error) { setNotice({ text: error instanceof Error ? error.message : "The change could not be saved. Refresh and try again.", error: true }); return false; }
    finally { saving.current = false; setBusy(false); setSaveProgress(""); }
  }
  async function saveReview(review: AccountReview, next = false) {
    if (saving.current || availability !== "ready") return false;
    saving.current = true;
    setBusy(true); setNotice(null); setReceipt(null); setSaveProgress(`Saving 0 of ${review.commands.length} changes…`);
    try {
      const outcome = await executeAccountReview(review, state, dispatch, id, (done, total) => setSaveProgress(`Saving ${done} of ${total} changes…`));
      if (!outcome.ok) { setNotice({ text: `${outcome.confirmed} of ${outcome.total} changes confirmed. ${outcome.error}`, error: true }); return false; }
      setReceipt(outcome.receipt); setNotice({ text: `${review.movements.length === 1 ? "Payment updated" : `${review.movements.length} payments updated`}. Original amounts, fees and source evidence are preserved.`, error: false });
      if (next) {
        const current = review.movements[0]?.id;
        setMovementId(nextReviewMovement(outcome.state, current)?.id ?? null);
      } else setMovementId(null);
      return true;
    } catch {
      setReceipt(null);
      setNotice({ text: "The save result could not be confirmed. Reload your account records before trying again.", error: true });
      return false;
    } finally { saving.current = false; setBusy(false); setSaveProgress(""); }
  }
  async function undoReceipt() {
    if (!receipt || saving.current || !canUndoReceipt(state, receipt)) return;
    saving.current = true;
    setBusy(true); setNotice(null); setSaveProgress("Undoing this change…");
    try {
      const outcome = await undoAccountReceipt(receipt, state, dispatch, id);
      setReceipt(null);
      setNotice({ text: outcome.ok ? "This change was undone. Original source evidence is preserved." : `${outcome.confirmed} undo steps confirmed. ${outcome.error}`, error: !outcome.ok });
    } catch {
      setReceipt(null);
      setNotice({ text: "The undo result could not be confirmed. Reload your account records before trying again.", error: true });
    } finally { saving.current = false; setBusy(false); setSaveProgress(""); }
  }
  const filtered = useMemo(() => activityScope !== "activity" ? [] : filterActivityMovements(state, filters, view.reportRows), [state, activityScope, filters, view.reportRows]);

  return <AccountsError.Provider value={notice?.error ? notice.text : ""}><div className="alfred-accounts" aria-busy={busy}>
    {paymentUnavailable ? <p className="alfred-accounts-smallNote" role="status">That payment isn’t available in this account. You can review your other records in Activity.</p> : null}
    <div className="alfred-accounts-heading"><div><h1>Accounts</h1><p>Your balances and everything moving between them.</p></div>{mode === "preview" ? <span className="alfred-accounts-demo">Demo · sample data only</span> : null}</div>
    {availability === "migration-required" ? <div className="alfred-accounts-message" role="status"><strong>Account storage is not set up yet.</strong><p>Changes cannot be saved yet. Your existing data is kept.</p></div> : null}
    {notice ? <div className={`alfred-accounts-message ${notice.error ? "is-error" : "is-success"}`} role={notice.error ? "alert" : "status"}>{notice.text}<button className={buttonClassName({ variant: "ghost", size: "icon" })} aria-label="Dismiss message" onClick={() => setNotice(null)}>×</button></div> : null}
    {busy ? <p className="alfred-accounts-saveProgress" role="status" aria-live="polite">{saveProgress || "Saving your change…"}</p> : null}
    {receipt?.ownerId === state.ownerId ? <ChangeReceipt receipt={receipt} state={state} money={money} busy={busy} open={setMovementId} undo={() => void undoReceipt()} dismiss={() => setReceipt(null)} /> : null}
    <section className="alfred-accounts-summary alfred-accounts-balanceCard" aria-label="Account summary">
      <div className="alfred-accounts-total"><div className="alfred-accounts-balanceLabel"><span>Total account balance</span><Glyph /></div><strong>{view.balances.totalMinor === null ? "—" : money(view.balances.totalMinor)}</strong><p className="alfred-accounts-balanceFreshness">Latest reported balances · Not live</p>{view.balances.missingCount ? <p className="alfred-accounts-balanceWarning">{view.balances.missingCount} included {view.balances.missingCount === 1 ? "account needs" : "accounts need"} a reported balance. Total is incomplete.</p> : null}
      {currencies.length > 1 ? <label className="alfred-accounts-compactCurrency"><span>Balance currency</span><Select aria-label="Balance currency" value={currency} onChange={(event) => setCurrency(event.target.value)}>{currencies.map((unit) => <option key={unit}>{unit}</option>)}</Select></label> : null}</div>
      <details className="alfred-accounts-balanceDisclosure"><summary><span>{state.accounts.length} {state.accounts.length === 1 ? "account" : "accounts"}<small>{view.balances.count} included in this balance</small></span><span className="alfred-accounts-chevron" aria-hidden="true">⌄</span></summary><div className="alfred-accounts-balanceContents">

      {!state.accounts.length ? firstUse ? <section className="alfred-accounts-welcome" aria-labelledby="accounts-start-title">
        <span className="alfred-accounts-welcomeIcon"><Glyph /></span>
        <p className="alfred-accounts-eyebrow">Start with an account</p>
        <h2 id="accounts-start-title">Give your money a home</h2>
        <p>Add a bank, mobile money or cash account. Your balance and activity will take shape as you add your records.</p>
        <ol><li><span>1</span><div><h3>Name your account</h3><p>Give it a name, provider and currency.</p></div></li><li><span>2</span><div><h3>Record a starting balance</h3><p>Add a reported balance now or come back to it later.</p></div></li></ol>
        <button data-account-create className={buttonClassName({ variant: "primary", size: "md", className: "alfred-accounts-primary alfred-button--mobileFull" })} onClick={() => setAccountEditor("new")} disabled={busy}>Add your first account <Glyph kind="plus" /></button>
        <p className="alfred-accounts-welcomeNote">A balance stays unknown until you record it.</p>
      </section> : <div className="alfred-accounts-empty"><Glyph /><h3>Give your money a home</h3><p>{availability === "ready" ? "Add a bank, mobile money or cash account, then assign your recorded movements to it." : "Your accounts will appear here when account storage is available."}</p><button data-account-create className={buttonClassName({ variant: "primary", size: "md", className: "alfred-accounts-primary alfred-button--mobileFull" })} onClick={() => setAccountEditor("new")} disabled={availability !== "ready"}>Add your first account</button></div> : null}
      <div className="alfred-accounts-grid">{view.balances.accounts.map(({ account, snapshot, reconciliation }) => <details className="alfred-account-card" key={account.id}>
        <summary className="alfred-account-compactSummary"><span className="alfred-account-symbol"><Glyph /></span><span><strong>{account.label}</strong><small>{account.provider || "Account"}{!account.includeInCash ? " · Not included" : ""}</small></span><strong>{snapshot ? money(snapshot.balanceMinor, account.currency) : "Not recorded"}</strong><span className="alfred-accounts-chevron" aria-hidden="true">⌄</span></summary><div className="alfred-account-cardBody">
        <header><div><h3>{account.label}</h3><p>{account.provider || "Account"} · {account.currency}</p></div><button className={buttonClassName({ variant: "ghost", size: "sm", className: "alfred-accounts-textButton" })} onClick={() => setAccountEditor(account)} aria-label={`Edit ${account.label}`}>Edit</button></header>
        <div className="alfred-account-balance"><span>Latest reported balance</span><strong>{snapshot ? money(snapshot.balanceMinor, account.currency) : "Not recorded"}</strong><p>{snapshot ? date(snapshot.occurredAt) : "Add an opening balance or a reported snapshot."}</p>{snapshot ? <p className="alfred-account-freshness">{Math.max(0, Math.floor((Date.parse(now ?? new Date().toISOString()) - Date.parse(snapshot.occurredAt)) / 86400000)) > 1 ? `${Math.floor((Date.parse(now ?? new Date().toISOString()) - Date.parse(snapshot.occurredAt)) / 86400000)} days old` : "Recent snapshot"} · Reported, not live</p> : null}</div>
        <label className="alfred-account-inclusion"><input type="checkbox" checked={account.includeInCash} disabled={busy || availability !== "ready"} onChange={(event) => { void run({ type: "update_account", accountId: account.id, changes: { includeInCash: event.target.checked } }, "Account inclusion updated."); }} /><span>Include in cash balance</span></label>
        <div className={`alfred-account-reconciliation is-${reconciliation.status}`}><div><span className="alfred-account-statusDot" /><h4>{reconciliation.status === "matched" ? "Recorded movements match" : reconciliation.status === "mismatch" ? "Difference to investigate" : reconciliation.status === "incomplete" ? "Incomplete movement coverage" : "More evidence needed"}</h4></div>{reconciliation.expectedMinor !== null ? <dl><div><dt>Expected from records</dt><dd>{money(reconciliation.expectedMinor, account.currency)}</dd></div><div><dt>Observed balance</dt><dd>{snapshot ? money(snapshot.balanceMinor, account.currency) : "—"}</dd></div><div><dt>Difference</dt><dd>{reconciliation.differenceMinor === null ? "—" : money(reconciliation.differenceMinor, account.currency)}</dd></div></dl> : null}<p>{reconciliation.reason}</p></div>
        <BalanceHistory snapshots={state.snapshots} account={account} money={money} />
        <footer><button className={buttonClassName({ variant: "ghost", size: "sm" })} onClick={() => { setAccountFilter(account.id); setTab("activity"); }}>View movements <Glyph kind="arrow" /></button><button className={buttonClassName({ variant: "secondary", size: "sm" })} onClick={() => setSnapshotAccount(account)} disabled={availability !== "ready"}>Record balance</button></footer>
      </div></details>)}</div>
      {!firstUse ? <div className="alfred-accounts-note"><strong>A balance is a point in time.</strong><p>Reconciliation compares recorded movements between two snapshots. A match describes those records; missing alerts or unknown timestamps may still leave gaps. Never add income and spending to a reported balance.</p></div> : null}

      {!firstUse && state.accounts.length ? <button data-account-create className={buttonClassName({ variant: "secondary", size: "md", className: "alfred-accounts-addFromCard alfred-button--mobileFull" })} onClick={() => setAccountEditor("new")} disabled={busy || availability !== "ready"}><Glyph kind="plus" /> Add account</button> : null}
      </div></details>
    </section>
    {firstUse ? <div className="alfred-accounts-firstAction"><button data-account-create className={buttonClassName({ variant: "primary", size: "md", className: "alfred-button--mobileFull" })} onClick={() => setAccountEditor("new")} disabled={busy}>Add your first account <Glyph kind="plus" /></button><p>A balance stays unknown until you record it.</p></div> : null}
    <section className="alfred-accounts-activityWorkspace" aria-labelledby="accounts-activity-title">
      <div className="alfred-accounts-sectionHeading alfred-accounts-activityHeading"><div><h2 id="accounts-activity-title">Activity</h2><p>Payments, transfers and the records that connect them.</p></div>{activityScope === "activity" && state.movements.length > 0 ? <Button size="sm" className="alfred-button--compact alfred-accounts-filterToggle" onClick={openFilters} aria-label={activeFilterCount ? `Filters, ${activeFilterCount} active` : "Filters"} aria-haspopup="dialog"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 17h16M9 4v6M15 14v6" /></svg>Filters{activeFilterCount ? <span className="alfred-accounts-filterCount">{activeFilterCount}</span> : null}</Button> : null}</div>
      <div className="alfred-accounts-activityScopes" role="tablist" aria-label="Activity views" onKeyDown={(event) => { const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')); const current = buttons.indexOf(document.activeElement as HTMLButtonElement); const next = event.key === "ArrowRight" ? (current + 1) % buttons.length : event.key === "ArrowLeft" ? (current - 1 + buttons.length) % buttons.length : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : null; if (next !== null) { event.preventDefault(); buttons[next]?.click(); buttons[next]?.focus(); } }}>{([['activity','All activity'],['needs-attention','Needs attention'],['settlements','Refunds & loans'],['subscriptions','Subscriptions']] as const).map(([value,label]) => <button key={value} role="tab" tabIndex={activityScope === value ? 0 : -1} aria-selected={activityScope === value} aria-controls={`accounts-panel-${value}`} id={`accounts-tab-${value}`} onClick={() => setTab(value)}>{label}{value === "needs-attention" && attention.length ? <span>{attention.length}</span> : null}</button>)}</div>
      <div role="tabpanel" id={`accounts-panel-${activityScope}`} aria-labelledby={`accounts-tab-${activityScope}`}>
    {activityScope === "activity" ? <>
      <div className="alfred-accounts-search"><label htmlFor="accounts-activity-search">Search activity</label><div><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><input id="accounts-activity-search" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Merchant, category or reference" />{search ? <button type="button" className={buttonClassName({ variant: "ghost", size: "icon" })} onClick={() => setSearch("")} aria-label="Clear activity search">×</button> : null}</div></div>
      {hasFilters ? <div className="alfred-accounts-filterChips" role="group" aria-label="Active activity filters">
        {search ? <FilterChip label={`Search: ${search}`} clear={() => changeFilters({ search: "" })} /> : null}
        {accountFilter ? <FilterChip label={`Account: ${accountFilter === "unassigned" ? "Unassigned" : state.accounts.find(item => item.id === accountFilter)?.label ?? "Unavailable account"}`} clear={() => changeFilters({ account: "" })} /> : null}
        {statusFilter ? <FilterChip label={`Status: ${movementStatusLabel(statusFilter as CashMovement["status"])}`} clear={() => changeFilters({ status: "" })} /> : null}
        {filters.start || filters.end ? <FilterChip label={`${filters.start ? readableMovementDay(filters.start) : "Any date"} – ${filters.end ? readableMovementDay(filters.end) : "Any date"}`} clear={() => changeFilters({ start: "", end: "" })} /> : null}
        {filters.category ? <FilterChip label={`Category: ${filters.category}`} clear={() => changeFilters({ category: "" })} /> : null}
        {filters.type !== "all" ? <FilterChip label={filters.type === "expense" ? "Expenses" : "Income"} clear={() => changeFilters({ type: "all" })} /> : null}
        {filters.currency ? <FilterChip label={filters.currency} clear={() => changeFilters({ currency: "" })} /> : null}
        {filters.sort !== "date-desc" ? <FilterChip label={filters.sort === "date-asc" ? "Oldest first" : filters.sort === "amount-desc" ? "Largest first" : "Smallest first"} clear={() => changeFilters({ sort: "date-desc" })} /> : null}
        <button type="button" className={buttonClassName({ variant: "ghost", size: "sm" })} onClick={() => changeFilters({ ...emptyActivityFilters })}>Clear all</button>
      </div> : null}
      {filters.category || filters.type !== "all" ? <p className="alfred-accounts-smallNote">Showing the source payments behind this report. Fees and taxes stay with their payment; the amounts below are the original principal.</p> : null}
      <div className="alfred-accounts-sectionHeading"><div><h3>All activity</h3></div>{state.movements.length > 0 ? <span>{filtered.length} movements</span> : null}</div>

      <MovementList key={JSON.stringify(filters)} rows={filtered} accounts={state.accounts} money={money} open={setMovementId} empty={<div className="alfred-accounts-empty"><Glyph /><h3>{state.movements.length ? "No matching movements" : "No activity yet"}</h3><p>{state.movements.length ? "Try another search or clear the filters to see your recorded activity." : "Your recorded payments and transfers will appear here. Start by telling Alfred about an expense or income."}</p>{state.movements.length && hasFilters ? <button type="button" className={buttonClassName({ variant: "primary", size: "md", className: "alfred-accounts-primary alfred-button--mobileFull" })} onClick={() => changeFilters({ ...emptyActivityFilters })}>Clear filters</button> : <Link className={buttonClassName({ variant: "primary", size: "md", className: "alfred-accounts-primary alfred-button--mobileFull" })} href="/chat">Record a transaction <Glyph kind="arrow" /></Link>}</div>} />
      {state.movements.length > 0 ? <TransferForm state={state} busy={busy || availability !== "ready"} run={run} money={money} /> : null}
      {state.transfers.length ? <section className="alfred-accounts-panel"><h3>Confirmed transfers</h3>{state.transfers.map((transfer) => { const out = state.movements.find((item) => item.id === transfer.outgoing.movementId); const incoming = state.movements.find((item) => item.id === transfer.incoming.movementId); return <div className="alfred-accounts-linkRow" key={transfer.id}><div><strong>{out?.description ?? "Missing outgoing source"} → {incoming?.description ?? "Missing incoming source"}</strong><p>Own-account movement · Principal is excluded from income and spending; fees remain expenses.</p></div><button className={buttonClassName({ variant: "ghost", size: "sm" })} disabled={busy} onClick={() => { void run({ type: "unpair_transfer", transferId: transfer.id }, "Transfer link removed. Both sources are preserved."); }}>Undo link</button></div>; })}</section> : null}
    </> : null}
    {activityScope === "settlements" ? <Settlements state={state} busy={busy || availability !== "ready"} run={run} money={money} issues={view.settlementIssues} /> : null}
    {activityScope === "subscriptions" ? <section className="alfred-accounts-subscriptions"><div className="alfred-accounts-sectionHeading"><div><h2>Subscriptions</h2><p>All your saved bills and renewals, including one-time payments. Keep track of what is coming next.</p></div></div>{subscriptions ?? <p className="alfred-accounts-smallNote">Subscriptions are not available in this view.</p>}</section> : null}
    {activityScope === "needs-attention" ? <><div className="alfred-accounts-sectionHeading"><div><h2>Needs attention</h2><p>Review one payment at a time, or choose matching payments to categorise together.</p></div><span>{attention.length} movements remaining</span></div>
      {attention.length ? <div className="alfred-accounts-reviewStart"><div><strong>{attention.length} {attention.length === 1 ? "payment needs" : "payments need"} a review</strong><p>Check its account, category and status, then use Save &amp; next.</p></div><Button variant="primary" disabled={busy || availability !== "ready"} onClick={() => setMovementId(attention.find(row => !movementIsLinked(state, row))?.id ?? attention[0].id)}>Start review</Button></div> : null}
      {attentionGroups.some(group => group.rows.length > 1) ? <section className="alfred-accounts-similar" aria-label="Similar payments to review"><h3>Review similar payments</h3><p>Grouped by the exact description, account, currency and direction. Review up to 25 at a time.</p><div>{attentionGroups.filter(group => group.rows.length > 1).slice(0, 6).map(group => { const rows = group.rows.filter(row => row.status !== "transfer" && !movementIsLinked(state, row)).slice(0, 25); return <article key={group.key}><div><strong>{group.rows[0].description}</strong><small>{state.accounts.find(account => account.id === group.rows[0].accountId)?.label ?? "Unassigned"} · {group.rows[0].currency} · {movementDirectionLabel(group.rows[0].direction)} · {group.rows.length} payments</small></div><Button size="sm" disabled={busy || rows.length < 2 || availability !== "ready"} onClick={() => setBulkGroup(rows)}>Review similar</Button></article>; })}</div></section> : null}
      <MovementList rows={attention} accounts={state.accounts} money={money} open={setMovementId} empty={<div className="alfred-accounts-empty"><Glyph /><h3>{state.movements.length ? "You’re all caught up" : "No payments to review yet"}</h3><p>{state.movements.length ? "Your recorded movements have an account and no items are waiting here for review." : "When recorded payments need an account or a category, you’ll find them here."}</p></div>} /><p className="alfred-accounts-smallNote">Use Refunds & loans to link returns, or All activity to connect transfers. Money held for other people can be added later.</p></> : null}
    </div></section>
    {!firstUse || onReset ? <footer className="alfred-accounts-pageFooter"><span>{storageHint ?? (mode === "preview" ? "Synthetic records · Changes stay in this browser" : "Your saved account records")} · Changes are tracked</span><div><button className={buttonClassName({ variant: "ghost", size: "sm" })} disabled={busy || !state.audit.length || availability !== "ready"} onClick={() => { void run({ type: "undo" }, "Last account change undone. Source evidence is preserved."); }}>Undo last change</button>{onReset ? <button className={buttonClassName({ variant: "ghost", size: "sm" })} disabled={busy} onClick={() => { onReset(); setNotice({ text: "Synthetic account records reset.", error: false }); }}>Reset demo</button> : null}</div></footer> : null}
    <Dialog open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Filter activity">
      <form className="alfred-accounts-filterSheet" onSubmit={applyFilters}>
        <Field label="Search"><input type="search" placeholder="Description, category or source" value={draftFilters.search} onChange={(event) => setDraftFilters({ ...draftFilters, search: event.target.value })} /></Field>
        <Field label="Account"><Select value={draftFilters.account} onChange={(event) => setDraftFilters({ ...draftFilters, account: event.target.value })}><option value="">All accounts</option><option value="unassigned">Unassigned</option>{state.accounts.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</Select></Field>
        <Field label="Status"><Select value={draftFilters.status} onChange={(event) => setDraftFilters({ ...draftFilters, status: event.target.value })}><option value="">All statuses</option>{(["confirmed","review","hold","transfer","duplicate","excluded"] as const).map((status) => <option key={status} value={status}>{movementStatusLabel(status)}</option>)}</Select></Field>
        <Field label="Category"><Select value={draftFilters.category} onChange={event => setDraftFilters({ ...draftFilters, category: event.target.value })}><option value="">All categories</option>{[...new Set([...state.movements.map(item => item.category), ...view.reportRows.map(item => item.category)])].filter(Boolean).sort().map(category => <option key={category}>{category}</option>)}</Select></Field>
        <Field label="Type"><Select value={draftFilters.type} onChange={event => setDraftFilters({ ...draftFilters, type: event.target.value as ActivityFilters["type"] })}><option value="all">All activity types</option><option value="expense">Expenses</option><option value="income">Income</option></Select></Field>
        <div className="alfred-accounts-filterDates"><Field label="From"><TemporalInput type="date" value={draftFilters.start} onChange={event => setDraftFilters({ ...draftFilters, start: event.target.value })} /></Field><Field label="To"><TemporalInput type="date" value={draftFilters.end} onChange={event => setDraftFilters({ ...draftFilters, end: event.target.value })} /></Field></div>
        {draftFilters.start && draftFilters.end && draftFilters.start > draftFilters.end ? <p className="alfred-accounts-formError" role="alert">Choose an end date on or after the start date.</p> : null}
        <Field label="Currency"><Select value={draftFilters.currency} onChange={event => setDraftFilters({ ...draftFilters, currency: event.target.value })}><option value="">All currencies</option>{[...new Set(state.movements.map(item => item.currency))].sort().map(unit => <option key={unit}>{unit}</option>)}</Select></Field>
        <Field label="Sort"><Select value={draftFilters.sort} onChange={event => setDraftFilters({ ...draftFilters, sort: event.target.value as ActivityFilters["sort"] })}><option value="date-desc">Newest first</option><option value="date-asc">Oldest first</option><option value="amount-desc">Largest first</option><option value="amount-asc">Smallest first</option></Select></Field>
        <div className="alfred-accounts-filterSheetActions alfred-buttonGroup--mobileStack"><Button className="alfred-button--mobileFull" variant="ghost" onClick={() => setDraftFilters({ ...emptyActivityFilters })}>Reset filters</Button><Button className="alfred-button--mobileFull" type="submit" variant="primary">Apply filters</Button></div>
      </form>
    </Dialog>
    {accountEditor ? <AccountEditor account={accountEditor} defaultCurrency={currency} busy={busy} close={() => setAccountEditor(null)} run={run} /> : null}
    {snapshotAccount ? <SnapshotEditor account={snapshotAccount} now={now} busy={busy} close={() => setSnapshotAccount(null)} run={run} /> : null}
    {movement ? <MovementEditor key={`${state.ownerId}:${movement.id}`} movement={movement} state={state} busy={busy || availability !== "ready"} progress={saveProgress} close={() => setMovementId(null)} saveReview={saveReview} canNext={activityScope === "needs-attention" && Boolean(nextReviewMovement(state, movement.id))} money={money} /> : null}
    {bulkGroup ? <SimilarReview rows={bulkGroup} state={state} busy={busy} progress={saveProgress} close={() => setBulkGroup(null)} saveReview={async review => { const ok = await saveReview(review); if (ok) setBulkGroup(null); return ok; }} money={money} /> : null}
  </div></AccountsError.Provider>;
}

export function movementStatusLabel(status: CashMovement["status"]): string { return ({ confirmed: "Confirmed", review: "Needs review", hold: "On hold", transfer: "Own-account transfer", duplicate: "Duplicate", excluded: "Excluded" })[status]; }
export function movementDirectionLabel(direction: CashMovement["direction"]): string { return direction === "in" ? "Money in" : direction === "out" ? "Money out" : "Internal movement"; }

function MovementList({ rows, accounts, money, open, empty }: { rows: CashMovement[]; accounts: FinancialAccount[]; money: (value: number, currency?: string) => string; open: (id: string) => void; empty?: ReactNode }) {
  const [page, setPage] = useState(0);
  const window = accountListPage(rows, page);
  const accountLabels = useMemo(() => new Map(accounts.map(account => [account.id, account.label])), [accounts]);
  const days = useMemo(() => movementDayGroups(window.rows), [window.rows]);
  if (!rows.length) return empty ?? <p className="alfred-accounts-smallNote">No movements to show.</p>;
  return <><div className="alfred-accounts-movements">
    <table><caption className="sr-only">Account activity</caption><thead><tr><th>Date &amp; time</th><th>Movement</th><th>Account</th><th>Status</th><th className="is-numeric">Amount</th></tr></thead>
      {days.map(([day, items], groupIndex) => <tbody key={`${day}:${groupIndex}`} aria-label={readableMovementDay(day)}>{items.map((row, index) => <tr key={row.id} className={index === 0 ? "alfred-accounts-dayStart" : undefined}>
        <td className="alfred-accounts-tableDate">{index === 0 ? <strong>{readableMovementDay(day)}</strong> : null}<time dateTime={row.occurredAt ?? row.date}>{row.occurredAt ? movementClock(row.occurredAt) : "Time not recorded"}</time></td>
        <td><button className="alfred-accounts-tableMovement" onClick={() => open(row.id)} aria-label={`Open ${row.description}`}><span className={`alfred-accounts-directionIcon is-${row.direction}`} aria-hidden="true"><Glyph kind="arrow" /></span><span className="alfred-accounts-tableCopy"><strong>{row.description}</strong><small>{row.category}</small></span><span className="alfred-accounts-rowChevron" aria-hidden="true">›</span></button></td>
        <td className="alfred-accounts-tableAccount">{accountLabels.get(row.accountId ?? "") ?? "Unassigned"}</td><td><span className={`alfred-accounts-status is-${row.status}`}>{movementStatusLabel(row.status)}</span></td>
        <td className={`is-numeric is-${row.direction}`}><strong>{row.direction === "out" ? "−" : row.direction === "in" ? "+" : ""}{money(row.amountMinor,row.currency)}</strong><span>{movementDirectionLabel(row.direction)}</span>{row.feeMinor ? <span>Fee {money(row.feeMinor,row.currency)}</span> : null}{row.taxMinor ? <span>Tax {money(row.taxMinor,row.currency)}</span> : null}</td>
      </tr>)}</tbody>)}
    </table>
    <div className="alfred-accounts-mobileMovements">{days.map(([day, items], groupIndex) => <div className="alfred-accounts-dayGroup" key={`${day}:${groupIndex}`}><h4>{readableMovementDay(day)}</h4>{items.map(row => <button className="alfred-accounts-movementRow" key={row.id} onClick={() => open(row.id)} aria-label={`Open ${row.description}`}><span className={`alfred-accounts-directionIcon is-${row.direction}`} aria-hidden="true"><Glyph kind="arrow" /></span><span className="alfred-accounts-rowCopy"><strong>{row.description}</strong><span>{accountLabels.get(row.accountId ?? "") ?? "Unassigned"} · {row.category}</span><small>{row.occurredAt ? movementClock(row.occurredAt) : "Time not recorded"}</small><span className={`alfred-accounts-status is-${row.status}`}>{movementStatusLabel(row.status)}</span></span><span className="alfred-accounts-rowAmount"><strong className={`is-${row.direction}`}>{row.direction === "out" ? "−" : row.direction === "in" ? "+" : ""}{money(row.amountMinor,row.currency)}</strong><small>{movementDirectionLabel(row.direction)}</small>{row.feeMinor ? <small>Fee {money(row.feeMinor,row.currency)}</small> : null}</span><span className="alfred-accounts-rowChevron" aria-hidden="true">›</span></button>)}</div>)}</div>
  </div><AccountPageControls {...window} label="Movements" onPage={setPage} /></>;
}
function movementClock(value: string): string { const parsed = new Date(value); return Number.isNaN(parsed.valueOf()) ? value : new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Accra", timeZoneName: "short" }).format(parsed); }
function FilterChip({ label, clear }: { label: string; clear: () => void }) { return <button type="button" onClick={clear} aria-label={`Remove filter ${label}`}><span>{label}</span><span aria-hidden="true">×</span></button>; }
function ReviewSummary({ review, state, money }: { review: AccountReview; state: AccountingState; money: (value: number, currency?: string) => string }) {
  const account = (id: string | null) => state.accounts.find(item => item.id === id)?.label ?? "Unassigned";
  return <div className="alfred-accounts-changeSummary">{review.movements.map(item => <article key={item.id}><h3>{item.description}</h3><p>{readableMovementDay(item.date)} · {money(item.amountMinor, item.currency)}</p><dl>
    {item.before.accountId !== item.after.accountId ? <div><dt>Account</dt><dd><span>{account(item.before.accountId)}</span><span aria-hidden="true">→</span><strong>{account(item.after.accountId)}</strong></dd></div> : null}
    {item.before.category !== item.after.category ? <div><dt>Category</dt><dd><span>{item.before.category || "Uncategorised"}</span><span aria-hidden="true">→</span><strong>{item.after.category}</strong></dd></div> : null}
    {item.before.status !== item.after.status ? <div><dt>Status</dt><dd><span>{movementStatusLabel(item.before.status)}</span><span aria-hidden="true">→</span><strong>{movementStatusLabel(item.after.status)}</strong></dd></div> : null}
  </dl></article>)}</div>;
}
function ChangeReceipt({ receipt, state, money, busy, open, undo, dismiss }: { receipt: AccountChangeReceipt; state: AccountingState; money: (value: number, currency?: string) => string; busy: boolean; open: (id: string) => void; undo: () => void; dismiss: () => void }) {
  return <section className="alfred-accounts-changeReceipt" aria-label="Saved change receipt"><header><div><h2>Change saved</h2><p>{receipt.movements.length === 1 ? "One payment updated" : `${receipt.movements.length} payments updated`}</p></div><Button variant="ghost" size="icon" onClick={dismiss} aria-label="Dismiss change receipt">×</Button></header><ReviewSummary review={{ ownerId: receipt.ownerId, revision: receipt.revision, movements: receipt.movements, commands: [] }} state={state} money={money} /><div className="alfred-accounts-receiptFooter"><Button size="sm" disabled={busy} onClick={() => open(receipt.movements[0].id)}>View entry</Button><Button size="sm" disabled={busy || !canUndoReceipt(state, receipt)} onClick={undo}>Undo this change</Button>{!canUndoReceipt(state, receipt) ? <span>Undo is available only while this is the latest confirmed change.</span> : null}</div></section>;
}

function Modal({ title, children, close, busy = false }: { title: string; children: ReactNode; close: () => void; busy?: boolean }) {
  const dismiss = () => { if (!busy) close(); };
  const ref = useRef<HTMLElement>(null);
  const error = useContext(AccountsError);
  const previousTitle = useRef(title);
  useEffect(() => { if (previousTitle.current !== title) { previousTitle.current = title; ref.current?.querySelector<HTMLElement>("header h2")?.focus(); } }, [title]);
  useEffect(() => {
    const modal = ref.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const target = modal?.querySelector<HTMLElement>('input:not([type=checkbox]):not([type=hidden]),[role="combobox"],textarea,button') ?? modal; target?.focus();
    return () => {
      document.body.style.overflow = overflow;
      // React may autofocus a field before this effect, especially for a deep link.
      // Never restore focus to the dialog that is being removed or to the page body.
      if (previous?.isConnected && previous !== document.body && !modal?.contains(previous) && !previous.matches(":disabled")) {
        previous.focus({ preventScroll: true });
        return;
      }
      const fallback = Array.from(document.querySelectorAll<HTMLButtonElement>(".alfred-accounts [data-account-create]:not(:disabled)")).find((button) => !modal?.contains(button) && button.getClientRects().length > 0);
      fallback?.focus({ preventScroll: true });
    };
  }, []);
  return <div className="alfred-accounts-modalBackdrop" onClick={(event) => { if (event.target === event.currentTarget) dismiss(); }}><section ref={ref} className="alfred-accounts-modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onKeyDown={(event) => {
    if (event.key === "Escape") { event.stopPropagation(); dismiss(); }
    if (event.key === "Tab") {
      const focusable = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled):not([type=hidden]),[role="combobox"]:not(:disabled),textarea:not(:disabled),summary,a[href],[tabindex="0"]') ?? []).filter((node) => node.getClientRects().length > 0);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}><span className="alfred-accounts-sheetHandle" aria-hidden="true" /><header><h2 tabIndex={-1}>{title}</h2><button className={buttonClassName({ variant: "secondary", size: "icon" })} onClick={dismiss} disabled={busy} aria-label="Close dialog">×</button></header><div className="alfred-accounts-modalBody">{error ? <div className="alfred-accounts-message is-error" role="alert">{error}</div> : null}{children}</div></section></div>;
}
type Run = (command: Command, message: string) => Promise<boolean>;
function AccountEditor({ account, defaultCurrency, busy, close, run }: { account: FinancialAccount | "new"; defaultCurrency: string; busy: boolean; close: () => void; run: Run }) {
  const editing = account !== "new";
  const [error,setError] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const data = new FormData(event.currentTarget); const label = String(data.get("label") ?? "").trim(); const provider = String(data.get("provider") ?? "").trim(); const currency = String(data.get("currency") ?? "").trim().toUpperCase(); if (!label || !provider || !/^[A-Z]{3}$/.test(currency)) { setError("Enter an account name, provider and three-letter currency code."); return; } const ok = await run(editing ? { type: "update_account", accountId: account.id, changes: { label, provider, includeInCash: data.get("included") === "on" } } : { type: "create_account", account: { id: id(), label, provider, currency, includeInCash: data.get("included") === "on" } }, editing ? "Account updated." : "Account created. Assign its movements or record its first balance."); if (ok) close(); }
  return <Modal title={editing ? "Edit account" : "Add account"} close={close}><form onSubmit={save} data-preview-local-form="true"><Field label="Account name"><input autoFocus name="label" required maxLength={80} defaultValue={editing ? account.label : ""} placeholder="e.g. Main bank account" /></Field><Field label="Provider"><input name="provider" required maxLength={80} defaultValue={editing ? account.provider : ""} placeholder="Bank, mobile money or cash" /></Field><Field label="Currency"><input name="currency" required pattern="[A-Za-z]{3}" maxLength={3} defaultValue={editing ? account.currency : defaultCurrency} readOnly={editing} /></Field><label className="alfred-account-inclusion"><input name="included" type="checkbox" defaultChecked={editing ? account.includeInCash : true} />Include in cash balance</label>{error ? <p role="alert" className="alfred-accounts-formError">{error}</p> : null}<footer><div className="alfred-accounts-modalActions alfred-buttonGroup--mobileStack"><button className={buttonClassName({ variant: "secondary", size: "sm", className: "alfred-button--mobileFull" })} type="button" onClick={close}>Cancel</button><button className={buttonClassName({ variant: "primary", size: "md", className: "alfred-accounts-primary alfred-button--mobileFull" })} disabled={busy}>{editing ? "Save account" : "Create account"}</button></div></footer></form></Modal>;
}
function SnapshotEditor({ account, now, busy, close, run }: { account: FinancialAccount; now?: string; busy: boolean; close: () => void; run: Run }) {
  const [error,setError] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const data = new FormData(event.currentTarget); try { const balanceMinor = toMinor(String(data.get("balance"))); const occurredAt = new Date(`${String(data.get("at"))}Z`).toISOString(); if (!Number.isSafeInteger(balanceMinor)) throw new Error("Enter a valid balance."); const ok = await run({ type: "record_snapshot", snapshot: { id: id(), accountId: account.id, balanceMinor, occurredAt, sourceId: String(data.get("source")).trim(), sourceMovementId: null } }, "Reported balance recorded. Reconciliation uses the source timestamp."); if (ok) close(); } catch(error) { setError(error instanceof Error ? error.message : "Check the balance and timestamp."); } }
  return <Modal title={`Record ${account.label} balance`} close={close}><form data-preview-local-form="true" onSubmit={save}><p className="alfred-accounts-smallNote">Record the balance exactly as reported by the account. This adds evidence; it does not create income.</p><Field label={`Reported balance (${account.currency})`}><input autoFocus name="balance" required inputMode="decimal" placeholder="0.00" /></Field><Field label="Reported at (GMT / UTC)"><TemporalInput name="at" type="datetime-local" required defaultValue={(now ?? new Date().toISOString()).slice(0,16)} /></Field><Field label="Evidence / reference"><input name="source" required maxLength={200} placeholder="Statement date or alert reference" /></Field>{error ? <p className="alfred-accounts-formError" role="alert">{error}</p> : null}<footer><div className="alfred-accounts-modalActions alfred-buttonGroup--mobileStack"><button className={buttonClassName({ variant: "secondary", size: "sm", className: "alfred-button--mobileFull" })} type="button" onClick={close}>Cancel</button><button className={buttonClassName({ variant: "primary", size: "md", className: "alfred-accounts-primary alfred-button--mobileFull" })} disabled={busy}>Record balance</button></div></footer></form></Modal>;
}
function MovementEditor({ movement, state, busy, progress, close, saveReview, canNext, money }: { movement: CashMovement; state: AccountingState; busy: boolean; progress: string; close: () => void; saveReview: (review: AccountReview, next?: boolean) => Promise<boolean>; canNext: boolean; money: (value: number, currency?: string) => string }) {
  const [editing, setEditing] = useState(false), [review, setReview] = useState<AccountReview | null>(null);
  const editFields = useRef<HTMLDivElement>(null), editControl = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (editing && !review) editFields.current?.querySelector<HTMLElement>('input:not([type=hidden]),[role="combobox"]')?.focus(); }, [editing, review]);
  const [category, setCategory] = useState(movement.category), [accountId, setAccountId] = useState(movement.accountId ?? "");
  const [status, setStatus] = useState(["transfer", "review"].includes(movement.status) ? "confirmed" : movement.status);
  const [custom, setCustom] = useState(false), [customName, setCustomName] = useState(""), [categoryError, setCategoryError] = useState("");
  const [masked] = usePrivacyMask();
  const choices = [...new Set([...(movement.direction === "in" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES), ...state.movements.map(item => item.category)].filter(Boolean))].sort();
  const linked = movementIsLinked(state, movement), account = state.accounts.find(item => item.id === movement.accountId);
  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setCategoryError(""); const selected = custom ? customName.trim() : category;
    if (custom && choices.some(value => value.toLowerCase() === selected.toLowerCase())) { setCategoryError("That category already exists. Choose it from the list."); return; }
    try { setReview(prepareMovementReview(state, movement.id, { accountId: accountId || null, category: selected, status })); }
    catch (error) { setCategoryError(error instanceof Error ? error.message : "Check these details before reviewing."); }
  }
  return <Modal title={review ? "Review payment changes" : "Transaction details"} close={close} busy={busy}>
    {review ? <><ReviewSummary review={review} state={state} money={money} /><p className="alfred-accounts-smallNote">Your payment amount, fee and original source stay attached to this record.</p>{review.revision !== state.revision && !busy ? <p className="alfred-accounts-formError" role="alert">Records changed after this review. Go back and check the latest details.</p> : null}<footer><div className="alfred-accounts-modalActions alfred-buttonGroup--mobileStack"><Button onClick={() => setReview(null)} disabled={busy}>Back</Button><Button variant="primary" disabled={busy || review.revision !== state.revision} onClick={() => void saveReview(review, canNext)}>{busy ? "Saving…" : canNext ? "Confirm & next" : "Confirm changes"}</Button></div></footer></> : <>
      <div className={`alfred-accounts-receiptHero is-${movement.direction}`}><span className="alfred-accounts-receiptDirection"><span className="alfred-accounts-directionIcon" aria-hidden="true"><Glyph kind="arrow" /></span>{movementDirectionLabel(movement.direction)}</span><strong>{movement.direction === "out" ? "−" : movement.direction === "in" ? "+" : ""}{money(movement.amountMinor, movement.currency)}</strong><h3>{movement.description}</h3><p>{movement.occurredAt ? date(movement.occurredAt) : `${readableMovementDay(movement.date)} · Time not recorded`}</p></div>
      <dl className="alfred-accounts-receiptFacts"><div><dt>Account</dt><dd>{account?.label ?? "Unassigned"}</dd></div><div><dt>Category</dt><dd>{movement.category || "Uncategorised"}</dd></div><div><dt>Status</dt><dd><span className={`alfred-accounts-status is-${movement.status}`}>{movementStatusLabel(movement.status)}</span></dd></div>{movement.feeMinor ? <div><dt>Fee</dt><dd>{money(movement.feeMinor,movement.currency)}</dd></div> : null}{movement.taxMinor ? <div><dt>Tax</dt><dd>{money(movement.taxMinor,movement.currency)}</dd></div> : null}{movement.reportedBalanceMinor != null ? <div><dt>Balance after</dt><dd>{money(movement.reportedBalanceMinor,movement.currency)}</dd></div> : null}</dl>
      {!editing ? <div className="alfred-accounts-receiptActions">{!linked ? <button ref={editControl} type="button" className={buttonClassName({ variant: "secondary" })} onClick={() => setEditing(true)} disabled={busy}>Edit details</button> : <p className="alfred-accounts-smallNote">Linked to a transfer, refund or loan. Manage its link in Activity before changing its classification.</p>}</div> : <div ref={editFields} className="alfred-accounts-receiptEdit"><form data-preview-local-form="true" onSubmit={prepare}>
        <Field label="Assigned account"><Select aria-label="Assigned account" value={accountId} disabled={busy || linked} onChange={event => setAccountId(event.target.value)}><option value="" disabled>Choose an account</option>{state.accounts.filter(item => item.currency === movement.currency).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</Select></Field>
        <Field label="Category">{custom ? <input autoFocus value={customName} onChange={event => { setCustomName(event.target.value); setCategoryError(""); }} maxLength={40} required placeholder="New category name" aria-label="New category name" /> : <Select value={category} onChange={event => setCategory(event.target.value)}>{choices.map(value => <option key={value}>{value}</option>)}</Select>}</Field><Button variant="ghost" size="sm" onClick={() => setCustom(!custom)}>{custom ? "Choose an existing category" : "+ Add category"}</Button>
        <Field label="Status"><Select name="status" value={status} onChange={event => setStatus(event.target.value as CashMovement["status"])}><option value="confirmed">Confirmed</option><option value="review">Needs review</option><option value="hold">On hold</option><option value="duplicate">Duplicate</option><option value="excluded">Excluded</option></Select></Field><p className="alfred-accounts-smallNote">Review, duplicate and excluded records do not count as ordinary income or spending. Outgoing holds count provisionally; incoming holds do not count as income.</p>
        {categoryError ? <p className="alfred-accounts-formError" role="alert">{categoryError}</p> : null}<footer><div className="alfred-accounts-modalActions alfred-buttonGroup--mobileStack"><Button onClick={() => { setEditing(false); requestAnimationFrame(() => editControl.current?.focus({ preventScroll: true })); }} disabled={busy}>Cancel editing</Button><Button variant="primary" type="submit" disabled={busy || custom && !customName.trim()}>Review changes</Button></div></footer>
      </form></div>}
      <details className="alfred-account-evidence"><summary>Original details</summary><dl>{movement.sourceLabel ? <div><dt>Sender</dt><dd>{movement.sourceLabel}</dd></div> : null}{movement.sourceText ? <div><dt>Original alert</dt><dd className="alfred-accounts-sourceText">{masked ? "Source alert hidden while amounts are masked." : movement.sourceText}</dd></div> : null}{movement.reportedBalanceBeforeMinor != null ? <div><dt>Balance before</dt><dd>{money(movement.reportedBalanceBeforeMinor,movement.currency)}</dd></div> : null}{movement.reportedBalanceMinor != null ? <div><dt>Balance after</dt><dd>{money(movement.reportedBalanceMinor,movement.currency)}</dd></div> : null}<div><dt>Fee (separate from principal)</dt><dd>{money(movement.feeMinor,movement.currency)}</dd></div></dl></details>
    </>}
    {busy ? <p className="alfred-accounts-saveProgress" role="status">{progress || "Saving…"}</p> : null}
  </Modal>;
}
function SimilarReview({ rows, state, busy, progress, close, saveReview, money }: { rows: CashMovement[]; state: AccountingState; busy: boolean; progress: string; close: () => void; saveReview: (review: AccountReview) => Promise<boolean>; money: (value: number, currency?: string) => string }) {
  const [selected, setSelected] = useState<string[]>([]), [category, setCategory] = useState(rows[0]?.category ?? "Other"), [review, setReview] = useState<AccountReview | null>(null), [error, setError] = useState("");
  const choices = [...new Set([...(rows[0]?.direction === "in" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES), ...rows.map(row => row.category)])].sort();
  function prepare() { try { setError(""); setReview(prepareSimilarReview(state, selected, category)); } catch (error) { setError(error instanceof Error ? error.message : "Check the selected payments."); } }
  return <Modal title={review ? "Review selected changes" : "Review similar payments"} close={close} busy={busy}>
    {review ? <><ReviewSummary review={review} state={state} money={money} /><p className="alfred-accounts-smallNote">Only the selected categories change. Accounts, statuses, amounts and fees are kept.</p>{review.revision !== state.revision && !busy ? <p role="alert" className="alfred-accounts-formError">Records changed. Go back and review the latest selection.</p> : null}<footer><div className="alfred-accounts-modalActions alfred-buttonGroup--mobileStack"><Button disabled={busy} onClick={() => setReview(null)}>Back</Button><Button variant="primary" disabled={busy || review.revision !== state.revision} onClick={() => void saveReview(review)}>{busy ? "Saving…" : `Apply ${review.movements.length} category changes`}</Button></div></footer></> : <>
      <p className="alfred-accounts-smallNote">{rows[0]?.description} · {rows[0]?.currency} · {rows.length} matching payments. Select each payment you want to change.</p>
      <label className="alfred-accounts-bulkSelect"><input type="checkbox" checked={selected.length === rows.length} onChange={event => setSelected(event.target.checked ? rows.map(row => row.id) : [])} /><span>Select all {rows.length} shown payments</span></label>
      <div className="alfred-accounts-bulkRows">{rows.map(row => <label className="alfred-accounts-bulkSelect" key={row.id}><input type="checkbox" checked={selected.includes(row.id)} onChange={event => setSelected(current => event.target.checked ? [...current, row.id] : current.filter(id => id !== row.id))} /><span><strong>{readableMovementDay(row.date)} · {money(row.amountMinor, row.currency)}</strong><small>{row.category || "Uncategorised"} · {movementStatusLabel(row.status)}</small></span></label>)}</div>
      <Field label="New category"><Select value={category} onChange={event => setCategory(event.target.value)}>{choices.map(value => <option key={value}>{value}</option>)}</Select></Field>
      {error ? <p role="alert" className="alfred-accounts-formError">{error}</p> : null}<footer><div className="alfred-accounts-modalActions alfred-buttonGroup--mobileStack"><Button disabled={busy} onClick={close}>Cancel</Button><Button variant="primary" disabled={busy || selected.length === 0} onClick={prepare}>Review {selected.length} selected</Button></div></footer>
    </>}{busy ? <p className="alfred-accounts-saveProgress" role="status">{progress || "Saving…"}</p> : null}
  </Modal>;
}

function TransferForm({ state, busy, run, money }: { state: AccountingState; busy: boolean; run: Run; money: (value: number, currency?: string) => string }) {
  const [open, setOpen] = useState(false);
  if (open) return <TransferFormFields state={state} busy={busy} run={run} money={money} />;
  return <section className="alfred-accounts-panel"><div className="alfred-accounts-sectionHeading"><div><h3>Connect an own-account transfer</h3><p>Select both sides. Principal and currency must match, and the accounts must be different.</p></div><button type="button" className={buttonClassName({ variant: "secondary", size: "sm" })} onClick={() => setOpen(true)} disabled={busy}>Connect transfer</button></div></section>;
}
function TransferFormFields({ state, busy, run, money }: { state: AccountingState; busy: boolean; run: Run; money: (value: number, currency?: string) => string }) {
  const [outId,setOut] = useState(""); const [inId,setIn] = useState("");
  const outgoing = state.movements.filter((item) => item.direction === "out" && item.status === "confirmed" && item.accountId);
  const incoming = state.movements.filter((item) => item.direction === "in" && item.status === "confirmed" && item.accountId);
  const out = outgoing.find((item) => item.id === outId); const incomingRow = incoming.find((item) => item.id === inId);
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!out || !incomingRow) return; const ok = await run({ type: "pair_transfer", id: id(), outgoing: reference(out), incoming: reference(incomingRow) }, "Own-account transfer confirmed. Principal is excluded from income and spending."); if (ok) { setOut(""); setIn(""); } }
  return <section className="alfred-accounts-panel"><div className="alfred-accounts-sectionHeading"><div><h3>Connect an own-account transfer</h3><p>Select both sides. Principal and currency must match, and the accounts must be different.</p></div></div><form className="alfred-accounts-linkForm" data-preview-local-form="true" onSubmit={save}><Field label="Money leaving"><Select required value={outId} onChange={(event) => setOut(event.target.value)}><option value="">Choose outgoing movement</option>{outgoing.map((row) => <option key={row.id} value={row.id}>{row.description} · {money(row.amountMinor,row.currency)}</option>)}</Select></Field><span aria-hidden="true">→</span><Field label="Money arriving"><Select required value={inId} onChange={(event) => setIn(event.target.value)}><option value="">Choose incoming movement</option>{incoming.map((row) => <option key={row.id} value={row.id}>{row.description} · {money(row.amountMinor,row.currency)}</option>)}</Select></Field><button className={buttonClassName({ variant: "primary", size: "md", className: "alfred-accounts-primary alfred-button--mobileFull" })} disabled={busy || !out || !incomingRow}>Confirm transfer</button></form></section>;
}
function Settlements({ state, busy, run, money, issues }: { state: AccountingState; busy: boolean; run: Run; money: (value: number, currency?: string) => string; issues: SettlementIssue[] }) {
  const [kind,setKind] = useState<"refund"|"loan">("refund"); const [originalId,setOriginal] = useState(""); const [returnId,setReturn] = useState(""); const [amount,setAmount] = useState(""); const [error,setError] = useState("");
  const [noReturn,setNoReturn] = useState(false);
  const originals = state.movements.filter((item) => item.direction === "out" && item.status === "confirmed"); const returns = state.movements.filter((item) => item.direction === "in" && item.status === "confirmed");
  const original = originals.find((item) => item.id === originalId); const incoming = returns.find((item) => item.id === returnId);
  const existing = state.settlements.find((item) => item.original.movementId === originalId && item.kind === kind);
  const used = state.settlements.filter((item) => item.original.movementId === originalId).flatMap((item) => item.returns).reduce((sum,item) => sum + item.principalMinor,0);
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setError(""); if (!original || (!incoming && !(kind === "loan" && noReturn))) return; try { const principalMinor = kind === "loan" && noReturn ? 0 : toMinor(amount); const ok = await run({ type: "save_settlement", settlement: { id: existing?.id ?? id(), kind, original: reference(original), returns: [...(existing?.returns ?? []), ...(incoming && !noReturn ? [{ ...reference(incoming), principalMinor }] : [])] } }, kind === "refund" ? "Partial refund linked to the original expense." : noReturn ? "Loan recorded. Outstanding principal is separate from spending." : "Loan repayment linked. Outstanding principal updated."); if (ok) { setReturn(""); setAmount(""); } } catch(error) { setError(error instanceof Error ? error.message : "Enter a valid principal amount."); } }
  const heading = <div className="alfred-accounts-sectionHeading"><div><h2>Refunds & loan repayments</h2><p>Link money coming back to the payment it belongs to. Keep each return separate from new income.</p></div></div>;
  if (state.movements.length === 0 && state.settlements.length === 0) return <>{heading}<div className="alfred-accounts-empty"><Glyph /><h3>Start with a recorded payment</h3><p>Record the original expense or loan first. When money comes back, link the refund or repayment here to keep it separate from new income.</p><Link className={buttonClassName({ variant: "primary", size: "md", className: "alfred-accounts-primary alfred-button--mobileFull" })} href={`/chat?question=${encodeURIComponent("Help me record a transaction.")}`}>Record a payment <Glyph kind="arrow" /></Link></div></>;
  return <>{heading}
    <section className="alfred-accounts-panel"><h3>Link a return</h3><form className="alfred-accounts-settlementForm" data-preview-local-form="true" onSubmit={save}><Field label="Kind of return"><Select value={kind} onChange={(event) => { setKind(event.target.value as "refund"|"loan"); setNoReturn(false); }}><option value="refund">Expense refund</option><option value="loan">Loan repayment</option></Select></Field><Field label="Original outgoing payment"><Select required value={originalId} onChange={(event) => setOriginal(event.target.value)}><option value="">Choose original payment</option>{originals.map((row) => <option key={row.id} value={row.id}>{row.description} · {money(row.amountMinor,row.currency)}</option>)}</Select></Field><Field label="Incoming return"><Select required={!noReturn} disabled={kind === "loan" && noReturn} value={returnId} onChange={(event) => setReturn(event.target.value)}><option value="">Choose incoming movement</option>{returns.map((row) => <option key={row.id} value={row.id}>{row.description} · {money(row.amountMinor,row.currency)}</option>)}</Select></Field><Field label={`Principal returned${original ? ` (${original.currency})` : ""}`}><input inputMode="decimal" required={!noReturn} disabled={kind === "loan" && noReturn} value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" /></Field>{kind === "loan" ? <label className="alfred-account-inclusion"><input type="checkbox" checked={noReturn} onChange={(event) => setNoReturn(event.target.checked)} />No repayment yet — record the original loan</label> : null}{original ? <p className="alfred-accounts-smallNote">Original principal {money(original.amountMinor,original.currency)} · Already linked {money(used,original.currency)} · Remaining {money(original.amountMinor-used,original.currency)}. Fees are not refundable principal.</p> : null}<p className="alfred-accounts-smallNote">Only confirmed payments in the same currency can be linked. A return can only be used once and cannot exceed the incoming amount or the original principal. Fees stay separate.</p>{error ? <p className="alfred-accounts-formError" role="alert">{error}</p> : null}<button className={buttonClassName({ variant: "primary", size: "md", className: "alfred-accounts-primary alfred-button--mobileFull" })} disabled={busy || !original || !(kind === "loan" && noReturn) && (!incoming || !amount)}>{kind === "loan" && noReturn ? "Record loan" : `Link ${kind === "refund" ? "refund" : "repayment"}`}</button></form></section>
    {issues.length ? <div className="alfred-accounts-message is-error" role="alert">{issues.length} linked {issues.length === 1 ? "record needs" : "records need"} attention because its original evidence changed. Its adjustment is withheld until the link is corrected.<ul>{issues.map((issue) => <li key={issue.link.id}>{issue.reason}</li>)}</ul></div> : null}
    <section className="alfred-accounts-panel"><h3>Linked returns</h3>{!state.settlements.length ? <p className="alfred-accounts-smallNote">No linked returns yet. You can link a partial refund or record several repayments against one loan.</p> : state.settlements.map((link) => { const source = state.movements.find((row) => row.id === link.original.movementId); const total = link.returns.reduce((sum,row) => sum + row.principalMinor,0); const issue = issues.find((item) => item.link.id === link.id); return <article className="alfred-accounts-settlement" key={link.id}><header><div><span className="alfred-accounts-eyebrow">{link.kind === "refund" ? "Expense refund" : "Loan repayment"}</span><h4>{source?.description ?? "Original source unavailable"}</h4>{issue ? <p className="alfred-accounts-formError">Needs review · Adjustment withheld. {issue.reason}</p> : null}</div><button className={buttonClassName({ variant: "ghost", size: "sm" })} disabled={busy} onClick={() => { void run({ type: "delete_settlement", settlementId: link.id }, "Return link removed. Original and incoming source records are preserved."); }}>Undo link</button></header><dl className="alfred-accounts-settlementTotals"><div><dt>Original principal</dt><dd>{source ? money(source.amountMinor,source.currency) : "—"}</dd></div><div><dt>{issue ? "Saved return records" : "Returned"}</dt><dd>{money(total,source?.currency)}</dd></div><div><dt>{link.kind === "loan" ? "Outstanding" : "Unrefunded"}</dt><dd>{source && !issue ? money(source.amountMinor-total,source.currency) : "—"}</dd></div></dl>{link.returns.map((entry) => { const returned = state.movements.find((row) => row.id === entry.movementId); return <div className="alfred-accounts-return" key={entry.movementId}><span>{returned?.description ?? "Return source unavailable"}<small>{date(returned?.occurredAt ?? null)}</small></span><strong>{money(entry.principalMinor,source?.currency)}</strong></div>; })}</article>; })}</section>
  </>;
}
