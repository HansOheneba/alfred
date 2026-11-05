"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import type { AccountingAction, FinancialAccount } from "@/lib/finance/accounting/types";
import type { AccountsReadEvidence, AccountsReadMovement, AccountsReadReturn, AccountsReadSettlement, AccountsReadSettlementPlan, AccountsReadSnapshot, AccountsReadTransfer, AccountsReadView } from "@/lib/finance/accounting/read-view";
import { formatMinor, toMinor } from "@/lib/finance/money";
import { categoryList } from "@/lib/finance/categories";
import { usePrivacyMask } from "@/app/components/app-shell";
import { useCustomCategories } from "@/app/components/category-catalog";
import { Button, Dialog } from "@/app/components/ui";
import { Select } from "@/app/components/select";
import { TemporalInput } from "@/app/components/temporal-input";
import { AccountPageControls, formatAccountTime } from "./account-history";
import { AccountEditor, Field, Glyph, Modal, MovementList, SnapshotEditor, accountWorkspaceHref, movementStatusLabel, resolveAccountWorkspaceTab } from "./accounts-workspace";
import { emptyActivityFilters, type AccountCommand, type ActivityFilters } from "./activity-tools";
import { activityHref, parseActivityHandoff } from "@/lib/web/activity-handoff";
import { AccountsErrorState, AccountsLoading } from "./accounts-status";
import { AccountsViewRequestError, requestAccountsView } from "./read-request";

type Selection = Record<string, string>;
type Money = (minor: number, currency?: string) => string;
type Run = (commands: AccountCommand[], message: string, revision?: number, sourceVersion?: string | null) => Promise<boolean>;
const ref = (row: AccountsReadMovement) => ({ movementId: row.id, sourceFingerprint: row.sourceFingerprint });
const uid = () => crypto.randomUUID();

export function accountsViewQuery(view: Pick<AccountsReadView, "currency" | "revision" | "sourceVersion">, selection: Selection, bind = true) {
  const params = new URLSearchParams({ currency: view.currency, section: "activity", page: "0", ...selection });
  if (bind) { params.set("expectedRevision", String(view.revision)); params.set("expectedSourceVersion", view.sourceVersion ?? ""); }
  return params;
}
function Pager({ view, onPage }: { view: AccountsReadView; onPage: (page: number) => void }) {
  const { page, pageSize, total } = view.page;
  return <AccountPageControls page={page} pageCount={Math.max(1, Math.ceil(total / pageSize))} start={total ? page * pageSize + 1 : 0} end={Math.min((page + 1) * pageSize, total)} total={total} label={view.page.section === "snapshots" ? "Balances" : "Records"} onPage={onPage} />;
}

/** Each disclosure owns one bounded page; obsolete responses never publish into a newer owner/version. */
export function useAccountsPanel(base: AccountsReadView, selection: Selection) {
  const [attempt, retry] = useState(0);
  const key = `${accountsViewQuery(base, selection)}:${attempt}`;
  const [result, setResult] = useState<{ key: string; view?: AccountsReadView; error?: string }>({ key: "" });
  useEffect(() => {
    let alive = true;
    void requestAccountsView({ ownerId: base.ownerId, query: accountsViewQuery(base, selection) }).then(view => { if (alive) setResult({ key, view }); }, error => { if (alive) setResult({ key, error: error instanceof Error ? error.message : "Records could not be loaded." }); });
    return () => { alive = false; };
    // The serialized key contains every selection and source-version field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, base.ownerId]);
  return { ...(result.key === key ? result : {}), retry: () => retry(value => value + 1) };
}
function PanelResult({ error, retry, children, ready }: { error?: string; retry: () => void; children: ReactNode; ready: boolean }) {
  return error ? <p role="alert">{error} <Button size="sm" onClick={retry}>Retry</Button></p> : ready ? children : <p role="status">Loading records…</p>;
}

export function AccountsReadClient({ initialView, initialError = "", initialUpdating = false, expectedOwnerId, defaultCurrency, paymentUnavailable = false }: { initialView: AccountsReadView | null; initialError?: string; initialUpdating?: boolean; expectedOwnerId: string; defaultCurrency: string; paymentUnavailable?: boolean }) {
  const initialOwnedView = initialView?.ownerId === expectedOwnerId ? initialView : null;
  const [view, setView] = useState(initialOwnedView), [error, setError] = useState(initialError), [notice, setNotice] = useState("");
  const [updating, setUpdating] = useState(initialUpdating);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [recovery, setRecovery] = useState(false), [readBlocked, setReadBlocked] = useState(!initialOwnedView);
  const [tab, setTab] = useState("accounts"), [filters, setFilters] = useState<ActivityFilters>({ ...emptyActivityFilters });
  const [editor, setEditor] = useState<FinancialAccount | "new" | null>(null), [snapshot, setSnapshot] = useState<FinancialAccount | null>(null);
  const [movement, setMovement] = useState<AccountsReadMovement | null>(null), [similar, setSimilar] = useState<string | null>(null), [filterOpen, setFilterOpen] = useState(false);
  const [receipt, setReceipt] = useState<{ revision: number; requests: string[]; movementIds: string[]; changes: string[] } | null>(null);
  const currentView = useRef(initialOwnedView), detailRead = useRef(0), blocked = useRef(!initialOwnedView);
  const selection = useRef<Selection>({ section: "activity", page: "0" }), reading = useRef(0), saving = useRef(false), alive = useRef(true);
  const [masked] = usePrivacyMask();
  const owner = view?.ownerId ?? expectedOwnerId;
  const money: Money = (minor, currency = view?.currency ?? defaultCurrency) => masked ? "••••••" : formatMinor(minor, currency);

  async function load(next = selection.current, fresh = false) {
    if (saving.current) return;
    blocked.current = true; setReadBlocked(true);
    const token = ++reading.current; detailRead.current++; selection.current = next; setLoading(true); setError("");
    try {
      const base = currentView.current ?? { currency: defaultCurrency, revision: 0, sourceVersion: null };
      const loaded = await requestAccountsView({ ownerId: expectedOwnerId, query: accountsViewQuery(base, next, !fresh && Boolean(currentView.current)) });
      if (alive.current && token === reading.current) { currentView.current = loaded; setView(loaded); setUpdating(false); blocked.current = false; setReadBlocked(false); setMovement(null); setSimilar(null); setEditor(null); setSnapshot(null); setReceipt(null); }
    } catch (error) { if (alive.current && token === reading.current) { blocked.current = true; setReadBlocked(true); setUpdating(error instanceof AccountsViewRequestError && error.status === 202); setError(error instanceof Error ? error.message : "Records could not be loaded."); } }
    finally { if (alive.current && token === reading.current) setLoading(false); }
  }
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let firstNavigation = true;
    const restore = () => {
      const params = new URLSearchParams(window.location.search), next = resolveAccountWorkspaceTab(params.get("tab"));
      const incoming = { ...emptyActivityFilters, ...parseActivityHandoff(window.location.search), account: params.get("account") ?? "", status: params.get("status") ?? "" };
      setTab(next); setFilters(incoming);
      if (params.get("add") === "1") setEditor("new");
      const shouldRead = !firstNavigation || next !== "accounts" || Object.values(incoming).some((value, index) => value !== Object.values(emptyActivityFilters)[index]);
      firstNavigation = false;
      if (shouldRead && next !== "subscriptions") void load(filterSelection(incoming, next));
    };
    restore(); window.addEventListener("popstate", restore); return () => window.removeEventListener("popstate", restore);
    // Initial navigation is interpreted once; later server reads retain their own owner/version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function navigate(next: string) {
    detailRead.current++; setTab(next); setMovement(null); setSimilar(null);
    window.history.pushState(window.history.state, "", accountWorkspaceHref(window.location.href, next as Parameters<typeof accountWorkspaceHref>[1]));
    if (next !== "subscriptions") void load(filterSelection(filters, next));
  }
  const run: Run = async (commands, message, reviewedRevision = view?.revision, reviewedSourceVersion = view?.sourceVersion) => {
    const current = currentView.current;
    if (!current || saving.current || loading || recovery || blocked.current || current.availability !== "ready") return false;
    if (!commands.length) { setError("Change a selected payment before confirming."); return false; }
    if (reviewedRevision !== current.revision || reviewedSourceVersion !== current.sourceVersion) { setError("Records changed after this review. Reload and review the latest details."); return false; }
    saving.current = true; detailRead.current++; setBusy(true); setError(""); setNotice(""); setReceipt(null); reading.current++;
    let latest = current; const requests: string[] = []; let refreshAfterConflict = false;
    try {
      for (const command of commands) {
        if (!alive.current) return false;
        const requestId = uid();
        latest = await requestAccountsView({ ownerId: owner, method: "POST", query: accountsViewQuery(latest, selection.current, false), action: { ...command, expectedRevision: latest.revision, requestId } as AccountingAction });
        requests.push(requestId); reading.current++; currentView.current = latest; if (alive.current) setView(latest);
      }
      if (alive.current) { setReceipt(commands.some(command => command.type === "undo") ? null : { revision: latest.revision, requests, movementIds: commands.flatMap(command => "movement" in command ? [command.movement.movementId] : []), changes: commands.map(command => command.type === "classify_movement" ? `Category: ${command.category} · Status: ${movementStatusLabel(command.status)}` : command.type === "assign_movement" ? `Account: ${latest.accounts.find(account => account.id === command.accountId)?.label ?? "Assigned account"}` : command.type.replaceAll("_", " ")) }); setNotice(message); setMovement(null); setSimilar(null); }
      return true;
    } catch (error) {
      if (alive.current) {
        if (requests.length) { setMovement(null); setSimilar(null); }
        setError(`${requests.length ? `${requests.length} of ${commands.length} changes confirmed. ` : ""}${error instanceof Error ? error.message : "The save could not be confirmed."}`);
        if (error instanceof AccountsViewRequestError && error.unconfirmed) setRecovery(true);
        else if (error instanceof AccountsViewRequestError && error.status === 409) { blocked.current = true; setReadBlocked(true); setNotice("Records changed. Reloading the latest view; review it before confirming again."); refreshAfterConflict = true; }
      }
      return false;
    } finally { saving.current = false; if (alive.current) { setBusy(false); if (refreshAfterConflict) void load(selection.current, true); } }
  };
  async function openMovement(row: AccountsReadMovement | string) {
    const token = ++detailRead.current, base = currentView.current;
    if (!base || saving.current || blocked.current) return;
    if (typeof row !== "string") { setMovement(row); return; }
    try {
      const next = await requestAccountsView({ ownerId: owner, query: accountsViewQuery(base, { section: "movement", movementId: row }) });
      if (alive.current && token === detailRead.current && currentView.current?.revision === base.revision && currentView.current?.sourceVersion === base.sourceVersion && next.page.section === "movement") setMovement(next.page.rows[0] ?? null);
    } catch (error) { if (alive.current && token === detailRead.current) setError(error instanceof Error ? error.message : "Payment could not be loaded."); }
  }
  async function startReview() {
    const token = ++detailRead.current, base = currentView.current;
    if (!base || saving.current || blocked.current) return;
    try {
      const next = await requestAccountsView({ ownerId: expectedOwnerId, query: accountsViewQuery(base, { section: "attention", page: "0" }) });
      if (alive.current && token === detailRead.current && currentView.current?.revision === base.revision && currentView.current?.sourceVersion === base.sourceVersion && next.page.section === "attention") {
        const first = next.page.rows.find(row => !row.linked);
        if (first) setMovement(first); else setNotice("No unlinked payments are waiting for review.");
      }
    } catch (error) { if (alive.current && token === detailRead.current) setError(error instanceof Error ? error.message : "Payments could not be loaded."); }
  }
  if (recovery) return <AccountsErrorState title="We couldn’t confirm that save." message={error} retryLabel="Reload latest records" onRetry={() => window.location.reload()} />;
  if (updating) return <AccountsErrorState title="Updating account records" message={error || "Alfred is updating your financial view. Please try again shortly."} retryLabel="Check latest records" onRetry={() => { void load(selection.current, true); }} />;
  if (!view) return loading ? <AccountsLoading /> : <AccountsErrorState message={error || "Your account records could not be loaded."} onRetry={() => { void load(selection.current, true); }} />;
  const writable = !busy && !loading && !readBlocked && view.availability === "ready";
  const rows = ["activity", "attention"].includes(view.page.section) ? view.page.rows as AccountsReadMovement[] : [];
  const activeRequests: string[] = [];
  for (const event of view.audit) { if (event.action === "undo") activeRequests.pop(); else activeRequests.push(event.requestId); }
  const undoReceipt = receipt && receipt.requests.length > 0 && receipt.revision === view.revision && receipt.requests.every((request, index) => activeRequests.at(-(receipt.requests.length - index)) === request);
  return <div className="alfred-accounts" aria-busy={busy || loading}>
    <div className="alfred-accounts-heading"><div><h1>Accounts</h1><p>Your balances and everything moving between them.</p></div></div>{paymentUnavailable ? <p className="alfred-accounts-smallNote" role="status">That payment isn’t available in this account. You can review your other records in Activity.</p> : null}
    {error ? <div className="alfred-accounts-message is-error" role="alert">{error} <Button size="sm" onClick={() => { void load({ ...selection.current, page: "0" }, true); }}>Reload latest records</Button></div> : null}
    {notice ? <div className="alfred-accounts-message is-success" role="status">{notice}{receipt ? <><ul>{receipt.changes.map((change, index) => <li key={index}>{change}</li>)}</ul>{receipt.movementIds.length ? <Button size="sm" onClick={() => { void openMovement(receipt.movementIds[0]); }}>View entry</Button> : null}<Button size="sm" variant="ghost" onClick={() => { setReceipt(null); setNotice(""); }}>Dismiss</Button></> : null}{undoReceipt ? <Button size="sm" disabled={!writable} onClick={() => { void run(receipt!.requests.map(() => ({ type: "undo" })), "This change was undone. Original source evidence is preserved."); }}>Undo this change</Button> : null}</div> : null}
    {view.availability !== "ready" ? <p className="alfred-accounts-message" role="status">Account storage is not set up yet. Changes cannot be saved yet. Your existing data is kept.</p> : null}
    {busy ? <p role="status" className="alfred-accounts-saveProgress">Saving your change…</p> : null}
    <section className="alfred-accounts-summary alfred-accounts-balanceCard" aria-label="Account summary">
      <div className="alfred-accounts-total"><div className="alfred-accounts-balanceLabel"><span>Total account balance</span><Glyph /></div><strong>{view.balances.totalMinor === null ? "—" : money(view.balances.totalMinor)}</strong><p className="alfred-accounts-balanceFreshness">Latest reported balances · Not live</p>{view.balances.missingCount ? <p className="alfred-accounts-balanceWarning">{view.balances.missingCount} included accounts need a reported balance. Total is incomplete.</p> : null}
        {view.facets.currencies.length > 1 ? <Field label="Balance currency"><Select value={view.currency} disabled={busy} onChange={event => { void load({ ...selection.current, currency: event.target.value }); }}>{view.facets.currencies.map(currency => <option key={currency}>{currency}</option>)}</Select></Field> : null}</div>
      <details className="alfred-accounts-balanceDisclosure"><summary><span>{view.accounts.length} accounts<small>{view.balances.count} included in this balance</small></span><span className="alfred-accounts-chevron" aria-hidden="true">⌄</span></summary><div className="alfred-accounts-balanceContents">
        {!view.accounts.length ? <section className="alfred-accounts-welcome"><p className="alfred-accounts-eyebrow">Start with an account</p><h2>Give your money a home</h2><p>Add a bank, mobile money or cash account. A balance stays unknown until you record it.</p><Button disabled={!writable} onClick={() => setEditor("new")}>Add your first account</Button></section> : null}
        <div className="alfred-accounts-grid">{view.balances.accounts.map(({ account, snapshot, reconciliation }) => <details className="alfred-account-card" key={account.id}>
          <summary className="alfred-account-compactSummary"><span className="alfred-account-symbol"><Glyph /></span><span><strong>{account.label}</strong><small>{account.provider}{!account.includeInCash ? " · Not included" : ""}</small></span><strong>{snapshot ? money(snapshot.balanceMinor, account.currency) : "Not recorded"}</strong><span className="alfred-accounts-chevron" aria-hidden="true">⌄</span></summary>
          <div className="alfred-account-cardBody"><header><div><h3>{account.label}</h3><p>{account.provider} · {account.currency}</p></div><Button size="sm" variant="ghost" disabled={!writable} onClick={() => setEditor(account)}>Edit</Button></header>
            <div className="alfred-account-balance"><span>Latest reported balance</span><strong>{snapshot ? money(snapshot.balanceMinor, account.currency) : "Not recorded"}</strong><p>{snapshot ? formatAccountTime(snapshot.occurredAt) : "Add an opening balance or reported snapshot."}</p></div>
            <label className="alfred-account-inclusion"><input type="checkbox" checked={account.includeInCash} disabled={!writable} onChange={event => { void run([{ type: "update_account", accountId: account.id, changes: { includeInCash: event.target.checked } }], "Account inclusion updated."); }} />Include in cash balance</label>
            <div className={`alfred-account-reconciliation is-${reconciliation.status}`}><h4>{reconciliation.status === "matched" ? "Recorded movements match" : reconciliation.status === "mismatch" ? "Difference to investigate" : "More evidence needed"}</h4>{reconciliation.expectedMinor !== null ? <dl><div><dt>Expected from records</dt><dd>{money(reconciliation.expectedMinor, account.currency)}</dd></div><div><dt>Difference</dt><dd>{reconciliation.differenceMinor === null ? "—" : money(reconciliation.differenceMinor, account.currency)}</dd></div></dl> : null}<p>{reconciliation.reason}</p></div>
            <LazyDisclosure label="Balance history"><ReadHistory base={view} account={account} money={money} /></LazyDisclosure>
            <footer><Button size="sm" variant="ghost" disabled={busy} onClick={() => { const next = { ...filters, account: account.id }; setFilters(next); setTab("activity"); const href = new URL(activityHref(next), window.location.href); href.searchParams.set("account", account.id); window.history.pushState(window.history.state, "", href.pathname + href.search); void load(filterSelection(next, "activity")); }}>View movements <Glyph kind="arrow" /></Button><Button size="sm" disabled={!writable} onClick={() => setSnapshot(account)}>Record balance</Button></footer>
          </div>
        </details>)}</div>
        <p className="alfred-accounts-note">A balance is a point in time. Reconciliation uses complete records between reported snapshots. Never add income and spending to a reported balance.</p>
      </div></details>
    </section>
    <div className="alfred-accounts-sectionHeading"><div /><Button size="sm" disabled={!writable} onClick={() => setEditor("new")}>Add account</Button></div>
    <section aria-labelledby="accounts-activity-title"><div className="alfred-accounts-sectionHeading"><h2 id="accounts-activity-title">Activity</h2><Button size="sm" disabled={busy} onClick={() => setFilterOpen(true)}>Filters</Button></div>
      <div className="alfred-accounts-activityScopes" role="tablist" aria-label="Activity views" onKeyDown={event => { const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')); const index = buttons.indexOf(document.activeElement as HTMLButtonElement); const next = event.key === "ArrowRight" ? (index + 1) % buttons.length : event.key === "ArrowLeft" ? (index - 1 + buttons.length) % buttons.length : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : null; if (next !== null) { event.preventDefault(); buttons[next]?.click(); buttons[next]?.focus(); } }}>{[["activity", "All activity"], ["needs-attention", "Needs attention"], ["settlements", "Refunds & loans"], ["subscriptions", "Subscriptions"]].map(([value, label]) => <button key={value} role="tab" aria-selected={(tab === "accounts" ? "activity" : tab) === value} tabIndex={(tab === "accounts" ? "activity" : tab) === value ? 0 : -1} disabled={busy} onClick={() => navigate(value)}>{label}{value === "needs-attention" && view.attentionCounts.total ? <span>{view.attentionCounts.total}</span> : null}</button>)}</div>
      {loading ? <p role="status">Loading records…</p> : null}
      {tab === "subscriptions" ? <ReadSubscriptions ownerId={owner} /> : tab === "settlements" ? <ReadSettlements key={`${view.ownerId}:${view.revision}:${view.sourceVersion}`} base={view} run={run} busy={!writable} money={money} /> : <>
        {tab === "needs-attention" ? <><div className="alfred-accounts-sectionHeading"><h3>Needs attention</h3><span>{view.attentionCounts.total} movements remaining</span><Button size="sm" disabled={!writable || !view.attentionCounts.total} onClick={() => { void startReview(); }}>Start review</Button></div>{view.attentionGroups.filter(group => group.total > 1).map(group => <div className="alfred-accounts-linkRow" key={group.key}><div><strong>{group.description}</strong><p>{group.total} matching payments · {group.currency}</p></div><Button size="sm" disabled={!writable} onClick={() => setSimilar(group.key)}>Review similar</Button></div>)}</> : null}
        <MovementList rows={rows} accounts={view.accounts} money={money} open={id => { const row = rows.find(item => item.id === id); if (row) setMovement(row); }} empty={<div className="alfred-accounts-empty"><h3>{view.counts.movements ? "No matching movements" : "No activity yet"}</h3><p>Your recorded payments and transfers appear here.</p><Link href="/chat">Record a transaction</Link></div>} />
        <Pager view={view} onPage={page => { void load({ ...selection.current, page: String(page) }); }} />
        {tab !== "needs-attention" && view.counts.movements ? <ReadTransfers key={`${view.ownerId}:${view.revision}:${view.sourceVersion}`} base={view} run={run} busy={!writable} money={money} /> : null}
      </>}
    </section>
    <footer className="alfred-accounts-pageFooter"><span>Your saved account records · Changes are tracked</span><Button size="sm" variant="ghost" disabled={!writable || !view.audit.length} onClick={() => { void run([{ type: "undo" }], "Last account change undone. Source evidence is preserved."); }}>Undo last change</Button></footer>
    {editor ? <AccountEditor account={editor} defaultCurrency={view.currency} busy={!writable} close={() => setEditor(null)} run={(command, message) => run([command], message)} /> : null}
    {snapshot ? <SnapshotEditor account={snapshot} busy={!writable} close={() => setSnapshot(null)} run={(command, message) => run([command], message)} /> : null}
    {movement ? <ReadMovementEditor key={`${movement.id}:${movement.sourceFingerprint}`} base={view} movement={movement} money={money} busy={!writable} error={error} close={() => setMovement(null)} run={run} next={id => { void openMovement(id); }} /> : null}
    {similar ? <ReadSimilar base={view} groupKey={similar} busy={!writable} run={run} money={money} close={() => setSimilar(null)} /> : null}
    <ReadFilters key={`${filterOpen}:${JSON.stringify(filters)}`} open={filterOpen} filters={filters} view={view} close={() => setFilterOpen(false)} apply={next => { setFilters(next); setFilterOpen(false); const href = new URL(activityHref(next), window.location.href); href.searchParams.set("tab", tab === "accounts" ? "activity" : tab); if (next.account) href.searchParams.set("account", next.account); if (next.status) href.searchParams.set("status", next.status); window.history.pushState(window.history.state, "", href.pathname + href.search); void load(filterSelection(next, tab)); }} />
  </div>;
}

function filterSelection(filters: ActivityFilters, tab: string): Selection {
  return { section: tab === "needs-attention" ? "attention" : tab === "settlements" ? "settlements" : "activity", page: "0", search: filters.search, account: filters.account, status: filters.status, from: filters.start, to: filters.end, category: filters.category, type: filters.type, sort: filters.sort, filterCurrency: filters.currency };
}
function LazyDisclosure({ label, children }: { label: string; children: ReactNode }) { const [open, setOpen] = useState(false); return <details className="alfred-account-evidence" onToggle={event => setOpen(event.currentTarget.open)}><summary>{label}</summary>{open ? children : null}</details>; }
function ReadHistory({ base, account, money }: { base: AccountsReadView; account: FinancialAccount; money: Money }) {
  const [page, setPage] = useState(0), data = useAccountsPanel(base, { section: "snapshots", accountId: account.id, page: String(page) });
  return <PanelResult {...data} ready={Boolean(data.view)}>{data.view ? <><dl>{(data.view.page.rows as AccountsReadSnapshot[]).map(row => <div key={row.id}><dt>{formatAccountTime(row.occurredAt)}</dt><dd>{money(row.balanceMinor, account.currency)}</dd></div>)}</dl><Pager view={data.view} onPage={setPage} /></> : null}</PanelResult>;
}
function ReadEvidence({ base, movement }: { base: AccountsReadView; movement: AccountsReadMovement }) {
  const [masked] = usePrivacyMask(), data = useAccountsPanel(base, { section: "evidence", movementId: movement.id, fingerprint: movement.sourceFingerprint });
  return <PanelResult {...data} ready={Boolean(data.view)}>{data.view ? <p className="alfred-accounts-sourceText">{masked ? "Source alert hidden while amounts are masked." : (data.view.page.rows[0] as AccountsReadEvidence | undefined)?.sourceText ?? "No original alert is attached to this source."}</p> : null}</PanelResult>;
}

function ReadMovementEditor({ base, movement, money, busy, error, close, run, next }: { base: AccountsReadView; movement: AccountsReadMovement; money: Money; busy: boolean; error: string; close: () => void; run: Run; next: (id: string) => void }) {
  const [accountId, setAccount] = useState(movement.accountId ?? ""), [category, setCategory] = useState(movement.category), [status, setStatus] = useState(["review", "transfer"].includes(movement.status) ? "confirmed" : movement.status);
  const [commands, setCommands] = useState<AccountCommand[] | null>(null), [localError, setError] = useState("");
  const [custom, setCustom] = useState(false), [customName, setCustomName] = useState("");
  const protectedClassification = Boolean(movement.legacyClassification);
  const selectedCategory = protectedClassification ? movement.category : custom ? customName.trim() : category;
  const categories = [...new Set([...categoryList(movement.direction === "in" ? "income" : "expense", useCustomCategories()), ...base.facets.categories, movement.category])];
  function review(event: FormEvent) {
    event.preventDefault(); setError("");
    if (movement.linked) { setError("Remove this payment's transfer or return link before changing its classification."); return; }
    if (!selectedCategory || selectedCategory.length > 40 || /[\u0000-\u001f]/.test(selectedCategory)) { setError("Use a category name of 1–40 characters."); return; }
    if (custom && !protectedClassification && categories.some(value => value.toLowerCase() === selectedCategory.toLowerCase())) { setError("That category already exists. Choose it from the list."); return; }
    const selectedStatus = protectedClassification ? movement.status : status;
    if (movement.legacyClassification && (selectedCategory !== movement.category || selectedStatus !== movement.status)) { setError("Review the existing loan or refund record in Chat before changing its category or status."); return; }
    const result: AccountCommand[] = [];
    if (accountId !== (movement.accountId ?? "")) { if (!accountId) { setError("Choose an assigned account."); return; } result.push({ type: "assign_movement", movement: ref(movement), accountId }); }
    if (selectedCategory !== movement.category || selectedStatus !== movement.status) result.push({ type: "classify_movement", movement: ref(movement), category: selectedCategory, status: selectedStatus as "confirmed" });
    if (!result.length) { setError("Change an account, category or status before reviewing."); return; } setCommands(result);
  }
  async function save(andNext: boolean) { const nextId = movement.nextReviewId; if (commands && await run(commands, "Payment updated. Original amounts and source evidence are preserved.", base.revision) && andNext && nextId) next(nextId); }
  return <Modal title={commands ? "Review changes" : movement.description} close={close} busy={busy}><p>{formatAccountTime(movement.occurredAt)} · {money(movement.amountMinor, movement.currency)}</p>
    {error || localError ? <p role="alert" className="alfred-accounts-formError">{localError || error}</p> : null}
    {commands ? <><dl><div><dt>Account</dt><dd>{base.accounts.find(item => item.id === movement.accountId)?.label ?? "Unassigned"} → {base.accounts.find(item => item.id === accountId)?.label ?? "Unassigned"}</dd></div><div><dt>Category</dt><dd>{movement.category} → {selectedCategory}</dd></div><div><dt>Status</dt><dd>{movementStatusLabel(movement.status)} → {status}</dd></div></dl><Button disabled={busy} variant="primary" onClick={() => { void save(false); }}>Confirm changes</Button>{movement.nextReviewId ? <Button disabled={busy} onClick={() => { void save(true); }}>Save &amp; next</Button> : null}<Button disabled={busy} variant="ghost" onClick={() => setCommands(null)}>Back</Button></> : <form onSubmit={review}>
      <Field label="Assigned account"><Select value={accountId} disabled={busy || movement.linked} onChange={event => setAccount(event.target.value)}><option value="">Unassigned</option>{base.accounts.filter(item => item.currency === movement.currency).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</Select></Field>
      <Field label="Category">{custom && !protectedClassification ? <input autoFocus aria-label="New category name" placeholder="New category name" maxLength={40} required disabled={busy} value={customName} onChange={event => setCustomName(event.target.value)} /> : <Select value={protectedClassification ? movement.category : category} disabled={busy || movement.linked || protectedClassification} onChange={event => setCategory(event.target.value)}>{categories.map(item => <option key={item}>{item}</option>)}</Select>}</Field>{!movement.linked && !protectedClassification ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => setCustom(!custom)}>{custom ? "Choose an existing category" : "+ Add category"}</Button> : null}
      <Field label="Status"><Select value={protectedClassification ? movement.status : status} disabled={busy || movement.linked || protectedClassification} onChange={event => setStatus(event.target.value as typeof status)}>{["confirmed", "review", "hold", "duplicate", "excluded"].map(item => <option key={item} value={item}>{item}</option>)}{movement.status === "transfer" ? <option value="transfer">Own-account transfer</option> : null}</Select></Field>
      {protectedClassification ? <p>This payment has an existing loan or refund record. <Link href={movement.sourceKind === "bank" && /^[0-9a-f-]{36}$/i.test(movement.sourceId) ? `/chat?payment=${movement.sourceId}` : "/chat"}>Review in Chat</Link> before changing its category or status.</p> : null}
      {movement.linked ? <p>This payment has a transfer or return link. Review that link before changing its classification.</p> : <Button type="submit" disabled={busy}>Review changes</Button>}
    </form>}
    <LazyDisclosure label="Original details"><p>{movement.sourceLabel} · Fees {money(movement.feeMinor, movement.currency)} · Taxes {money(movement.taxMinor ?? 0, movement.currency)}</p>{movement.reportedBalanceBeforeMinor != null ? <p>Balance before: {money(movement.reportedBalanceBeforeMinor, movement.currency)}</p> : null}{movement.reportedBalanceMinor != null ? <p>Balance after: {money(movement.reportedBalanceMinor, movement.currency)}</p> : null}<ReadEvidence base={base} movement={movement} /></LazyDisclosure>
  </Modal>;
}

function ReadFilters({ open, filters, view, close, apply }: { open: boolean; filters: ActivityFilters; view: AccountsReadView; close: () => void; apply: (filters: ActivityFilters) => void }) {
  const [draft, setDraft] = useState(filters);
  return <Dialog title="Filter activity" open={open} onClose={close}><form className="alfred-accounts-filterSheet" onSubmit={event => { event.preventDefault(); apply(draft); }}>
    <Field label="Search"><input type="search" maxLength={200} value={draft.search} onChange={event => setDraft({ ...draft, search: event.target.value })} /></Field>
    <Field label="Account"><Select value={draft.account} onChange={event => setDraft({ ...draft, account: event.target.value })}><option value="">All accounts</option><option value="unassigned">Unassigned</option>{view.accounts.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}</Select></Field>
    <Field label="Status"><Select value={draft.status} onChange={event => setDraft({ ...draft, status: event.target.value })}><option value="">All statuses</option>{["confirmed", "review", "hold", "transfer", "duplicate", "excluded"].map(status => <option key={status}>{status}</option>)}</Select></Field>
    <Field label="Category"><Select value={draft.category} onChange={event => setDraft({ ...draft, category: event.target.value })}><option value="">All categories</option>{view.facets.categories.map(category => <option key={category}>{category}</option>)}</Select></Field>
    <Field label="Type"><Select value={draft.type} onChange={event => setDraft({ ...draft, type: event.target.value as ActivityFilters["type"] })}><option value="all">All activity types</option><option value="expense">Expenses</option><option value="income">Income</option></Select></Field>
    <Field label="From"><TemporalInput type="date" value={draft.start} onChange={event => setDraft({ ...draft, start: event.target.value })} /></Field><Field label="To"><TemporalInput type="date" value={draft.end} onChange={event => setDraft({ ...draft, end: event.target.value })} /></Field>
    <Field label="Currency"><Select value={draft.currency} onChange={event => setDraft({ ...draft, currency: event.target.value })}><option value="">All currencies</option>{view.facets.currencies.map(currency => <option key={currency}>{currency}</option>)}</Select></Field>
    <Field label="Sort"><Select value={draft.sort} onChange={event => setDraft({ ...draft, sort: event.target.value as ActivityFilters["sort"] })}>{[["date-desc", "Newest first"], ["date-asc", "Oldest first"], ["amount-desc", "Largest first"], ["amount-asc", "Smallest first"]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
    <Button type="button" variant="ghost" onClick={() => setDraft({ ...emptyActivityFilters })}>Reset filters</Button><Button type="submit" variant="primary">Apply filters</Button>
  </form></Dialog>;
}

function MovementPicker({ base, direction, label, value, choose }: { base: AccountsReadView; direction: "in" | "out"; label: string; value: AccountsReadMovement | null; choose: (value: AccountsReadMovement) => void }) {
  const [open, setOpen] = useState(false);
  return <><Field label={label}><Button onClick={() => setOpen(true)}>{value?.description ?? `Choose ${label.toLowerCase()}`}</Button></Field>{open ? <TargetPicker base={base} direction={direction} choose={row => { choose(row); setOpen(false); }} close={() => setOpen(false)} /> : null}</>;
}
function TargetPicker({ base, direction, choose, close }: { base: AccountsReadView; direction: "in" | "out"; choose: (value: AccountsReadMovement) => void; close: () => void }) {
  const [masked] = usePrivacyMask();
  const [search, setSearch] = useState(""), [page, setPage] = useState(0), data = useAccountsPanel(base, { section: "targets", direction, search, page: String(page) });
  return <Modal title="Choose a recorded movement" close={close}><Field label="Search recorded movements"><input value={search} maxLength={200} onChange={event => { setSearch(event.target.value); setPage(0); }} /></Field><PanelResult {...data} ready={Boolean(data.view)}>{data.view ? <><ul>{(data.view.page.rows as AccountsReadMovement[]).map(row => <li key={row.id}><Button onClick={() => choose(row)}>{row.description} · {masked ? "••••••" : formatMinor(row.amountMinor, row.currency)} · {row.date}{row.linked ? " · Already linked" : ""}</Button></li>)}</ul><Pager view={data.view} onPage={setPage} /></> : null}</PanelResult></Modal>;
}
function ReadTransfers({ base, run, busy, money }: { base: AccountsReadView; run: Run; busy: boolean; money: Money }) {
  const [outgoing, setOutgoing] = useState<AccountsReadMovement | null>(null), [incoming, setIncoming] = useState<AccountsReadMovement | null>(null);
  return <><section className="alfred-accounts-panel"><h3>Link own-account transfer</h3><p>Pair equal principal moving between two of your accounts. Fees remain separate expenses.</p><MovementPicker base={base} direction="out" label="Outgoing payment" value={outgoing} choose={setOutgoing} /><MovementPicker base={base} direction="in" label="Incoming payment" value={incoming} choose={setIncoming} />{outgoing && incoming ? <p>{outgoing.description} → {incoming.description} · {money(outgoing.amountMinor, outgoing.currency)}</p> : null}<Button disabled={busy || !outgoing || !incoming} onClick={() => { if (outgoing && incoming) void run([{ type: "pair_transfer", id: uid(), outgoing: ref(outgoing), incoming: ref(incoming) }], "Own-account transfer linked. Fees remain expenses.").then(ok => { if (ok) { setOutgoing(null); setIncoming(null); } }); }}>Confirm transfer</Button></section>
    {base.counts.transfers ? <LazyDisclosure label={`Confirmed transfers (${base.counts.transfers})`}><TransferHistory base={base} run={run} busy={busy} /></LazyDisclosure> : null}</>;
}
function TransferHistory({ base, run, busy }: { base: AccountsReadView; run: Run; busy: boolean }) {
  const [page, setPage] = useState(0), data = useAccountsPanel(base, { section: "transfers", page: String(page) });
  return <PanelResult {...data} ready={Boolean(data.view)}>{data.view ? <>{(data.view.page.rows as AccountsReadTransfer[]).map(row => <div className="alfred-accounts-linkRow" key={row.link.id}><div><strong>{row.outgoing?.description ?? "Missing outgoing source"} → {row.incoming?.description ?? "Missing incoming source"}</strong><p>Own-account movement. Source evidence is preserved.</p></div><Button disabled={busy} onClick={() => { void run([{ type: "unpair_transfer", transferId: row.link.id }], "Transfer link removed. Both sources are preserved."); }}>Undo link</Button></div>)}<Pager view={data.view} onPage={setPage} /></> : null}</PanelResult>;
}
export function ReadSettlements({ base, run, busy, money }: { base: AccountsReadView; run: Run; busy: boolean; money: Money }) {
  const [kind, setKind] = useState<"refund" | "loan">("refund"), [original, setOriginal] = useState<AccountsReadMovement | null>(null), [returned, setReturned] = useState<AccountsReadMovement | null>(null), [amount, setAmount] = useState(""), [noReturn, setNoReturn] = useState(false), [error, setError] = useState("");
  const [page, setPage] = useState(0), data = useAccountsPanel(base, { section: "settlements", page: String(page) });
  const [planning, setPlanning] = useState(false), planningRef = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function save(event: FormEvent) {
    event.preventDefault(); setError("");
    if (planningRef.current || busy) return;
    planningRef.current = true; setPlanning(true);
    try {
      if (!original || (!(kind === "loan" && noReturn) && !returned)) throw new Error("Choose the original payment and its return.");
      const principalMinor = kind === "loan" && noReturn ? 0 : toMinor(amount);
      if (!(kind === "loan" && noReturn) && principalMinor <= 0) throw new Error("Enter positive principal returned.");
      const current = await requestAccountsView({ ownerId: base.ownerId, query: accountsViewQuery(base, { section: "settlement-plan", movementId: original.id, kind }) });
      if (!mounted.current) return;
      if (current.page.section !== "settlement-plan" || current.page.rows.length !== 1) throw new Error("Return records changed. Reload and review the original payment.");
      const plan = current.page.rows[0] as AccountsReadSettlementPlan;
      const ok = await run([{ type: "save_settlement", settlement: { id: plan.existing?.id ?? uid(), kind, original: plan.existing?.original ?? ref(original), returns: [...(plan.existing?.returns ?? []), ...(kind === "loan" && noReturn ? [] : [{ ...ref(returned!), principalMinor }])] } }], kind === "loan" && noReturn ? "Loan recorded. Original source evidence is preserved." : "Return linked. Original source evidence is preserved.", base.revision, base.sourceVersion);
      if (ok && mounted.current) { setOriginal(null); setReturned(null); setAmount(""); }
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : "Check the return details."); }
    finally { planningRef.current = false; if (mounted.current) setPlanning(false); }
  }
  return <><section className="alfred-accounts-panel"><h3>Refunds &amp; loans</h3><form onSubmit={save}><fieldset disabled={busy || planning}><Field label="Return type"><Select value={kind} onChange={event => { setKind(event.target.value as typeof kind); setNoReturn(false); }}><option value="refund">Expense refund</option><option value="loan">Money lent / repayment</option></Select></Field><MovementPicker base={base} direction="out" label="Original outgoing payment" value={original} choose={setOriginal} />{!(kind === "loan" && noReturn) ? <MovementPicker base={base} direction="in" label="Incoming return" value={returned} choose={setReturned} /> : null}<Field label="Principal returned"><input inputMode="decimal" value={amount} disabled={kind === "loan" && noReturn} onChange={event => setAmount(event.target.value)} /></Field>{kind === "loan" ? <label><input type="checkbox" checked={noReturn} onChange={event => setNoReturn(event.target.checked)} />No repayment yet — record the original loan</label> : null}{original ? <p>Original principal {money(original.amountMinor, original.currency)} · Already linked {money(original.returnedPrincipalMinor ?? 0, original.currency)} · Remaining {money(original.amountMinor - (original.returnedPrincipalMinor ?? 0), original.currency)}. Fees stay separate from refundable principal.</p> : null}{error ? <p role="alert">{error}</p> : null}<Button type="submit" disabled={busy || !original}>Confirm {kind === "loan" && noReturn ? "loan" : "return link"}</Button>{planning ? <p role="status">Reviewing saved return records…</p> : null}</fieldset></form></section>
    <section className="alfred-accounts-panel"><h3>Linked returns</h3><PanelResult {...data} ready={Boolean(data.view)}>{data.view ? <>{(data.view.page.rows as AccountsReadSettlement[]).map(row => <article className="alfred-accounts-settlement" key={row.id}><header><div><span>{row.kind === "loan" ? "Loan" : "Refund"}</span><h4>{row.original?.description ?? "Original source unavailable"}</h4>{row.issue ? <p role="alert">Needs review · Adjustment withheld. {row.issue}</p> : null}</div><Button disabled={busy} onClick={() => { void run([{ type: "delete_settlement", settlementId: row.id }], "Return link removed. Original and incoming source records are preserved."); }}>Undo link</Button></header><dl className="alfred-accounts-settlementTotals"><div><dt>Original principal</dt><dd>{row.original ? money(row.original.amountMinor, row.original.currency) : "—"}</dd></div><div><dt>{row.issue ? "Saved return records" : "Returned"}</dt><dd>{money(row.returnedMinor, row.original?.currency)}</dd></div><div><dt>{row.kind === "loan" ? "Outstanding" : "Unrefunded"}</dt><dd>{row.outstandingMinor === null ? "—" : money(row.outstandingMinor, row.original?.currency)}</dd></div></dl><LazyDisclosure label={`${row.returnCount} return records`}><ReturnHistory base={base} settlementId={row.id} money={money} currency={row.original?.currency} /></LazyDisclosure></article>)}<Pager view={data.view} onPage={setPage} /></> : null}</PanelResult></section></>;
}
function ReturnHistory({ base, settlementId, money, currency }: { base: AccountsReadView; settlementId: string; money: Money; currency?: string }) {
  const [page, setPage] = useState(0), data = useAccountsPanel(base, { section: "returns", settlementId, page: String(page) });
  return <PanelResult {...data} ready={Boolean(data.view)}>{data.view ? <>{(data.view.page.rows as AccountsReadReturn[]).map((row, index) => <div className="alfred-accounts-return" key={row.movement?.id ?? index}><span>{row.movement?.description ?? "Return source unavailable"}<small>{formatAccountTime(row.movement?.occurredAt ?? null)}</small></span><strong>{money(row.principalMinor, currency)}</strong></div>)}<Pager view={data.view} onPage={setPage} /></> : null}</PanelResult>;
}
export function ReadSimilar({ base, groupKey, busy, run, money, close }: { base: AccountsReadView; groupKey: string; busy: boolean; run: Run; money: Money; close: () => void }) {
  const [page, setPage] = useState(0), [category, setCategory] = useState(""), [selected, setSelected] = useState<string[]>([]), [review, setReview] = useState(false), data = useAccountsPanel(base, { section: "similar", groupKey, page: String(page) });
  const rows = data.view?.page.rows as AccountsReadMovement[] | undefined;
  const catalog = useCustomCategories();
  const categories = [...new Set([...categoryList(rows?.[0]?.direction === "in" ? "income" : "expense", catalog), ...base.facets.categories])].sort();
  const [error, setError] = useState("");
  return <Modal title="Review similar payments" close={close} busy={busy}>{error ? <p role="alert">{error}</p> : null}<PanelResult {...data} ready={Boolean(rows)}>{rows ? <><p>Choose up to 25 payments on this page. Amounts, accounts and source evidence are preserved.</p><label className="alfred-accounts-bulkSelect"><input type="checkbox" disabled={busy || review} checked={selected.length > 0 && rows.filter(row => !row.legacyClassification && !row.linked && row.status !== "transfer").every(row => selected.includes(row.id))} onChange={event => setSelected(event.target.checked ? rows.filter(row => !row.legacyClassification && !row.linked && row.status !== "transfer").map(row => row.id) : [])} />Select all {rows.length} shown payments</label>{rows.map(row => <label key={row.id} className="alfred-accounts-bulkSelect"><input type="checkbox" disabled={busy || review || Boolean(row.legacyClassification) || row.linked || row.status === "transfer"} checked={selected.includes(row.id)} onChange={event => setSelected(ids => event.target.checked ? [...ids, row.id] : ids.filter(id => id !== row.id))} />{row.description} · {money(row.amountMinor, row.currency)} · {row.date}</label>)}<Field label="Category"><Select disabled={review} value={category} onChange={event => setCategory(event.target.value)}><option value="">Choose category</option>{categories.map(item => <option key={item}>{item}</option>)}</Select></Field>{review ? <><p>Change {selected.length} selected payments to {category}?</p><Button disabled={busy} onClick={() => { const commands = rows.filter(row => selected.includes(row.id) && !row.legacyClassification && !row.linked && row.status !== "transfer" && row.category !== category).map(row => ({ type: "classify_movement" as const, movement: ref(row), status: row.status as "confirmed", category })); void run(commands, "Selected payments updated. Original sources are preserved.", base.revision).then(ok => { if (ok) close(); }); }}>Confirm changes</Button><Button disabled={busy} onClick={() => setReview(false)}>Back</Button></> : <Button disabled={busy || !selected.length || !category} onClick={() => { if (!rows.some(row => selected.includes(row.id) && !row.legacyClassification && !row.linked && row.status !== "transfer" && row.category !== category)) { setError("The selected payments already use that category."); return; } setError(""); setReview(true); }}>Review changes</Button>}<Pager view={data.view!} onPage={value => { setPage(value); setSelected([]); setReview(false); }} /></> : null}</PanelResult></Modal>;
}

function ReadSubscriptions({ ownerId }: { ownerId: string }) {
  return <ReadSubscriptionsContent key={ownerId} ownerId={ownerId} />;
}
import { BillsCard } from "@/app/dashboard/bills-card";
import { sendJson } from "@/app/components/ui";
import { loadAccountSubscriptionsView, type SubscriptionsData } from "./subscriptions-actions";
export async function requestAccountSubscriptions(ownerId: string, read = loadAccountSubscriptionsView, timeoutMs = 20_000): Promise<SubscriptionsData> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Subscriptions could not be loaded. Try again.")), timeoutMs); })]);
    if (!result.ok) throw new Error(result.text);
    if (result.ownerId !== ownerId) throw new Error("Your signed-in account changed. Reload Accounts.");
    return result.data;
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
export function ReadSubscriptionsContent({ ownerId }: { ownerId: string }) {
  const [data, setData] = useState<SubscriptionsData | null>(null), [error, setError] = useState(""), [attempt, retry] = useState(0);
  const alive = useRef(true), sequence = useRef(0);
  async function load() {
    const token = ++sequence.current; setData(null); setError("");
    try { const result = await requestAccountSubscriptions(ownerId); if (alive.current && token === sequence.current) setData(result); }
    catch (error) { if (alive.current && token === sequence.current) setError(error instanceof Error ? error.message : "Subscriptions could not be loaded. Try again."); throw error; }
  }
  useEffect(() => {
    alive.current = true; const token = ++sequence.current;
    void requestAccountSubscriptions(ownerId).then(result => { if (alive.current && token === sequence.current) { setData(result); setError(""); } }, error => { if (alive.current && token === sequence.current) setError(error instanceof Error ? error.message : "Subscriptions could not be loaded. Try again."); });
    return () => { alive.current = false; };
  }, [ownerId, attempt]);
  return error ? <p role="alert">{error}<Button onClick={() => { setData(null); setError(""); retry(value => value + 1); }}>Retry subscriptions</Button></p> : data ? <BillsCard showCategoryLink {...data} onAction={async action => {
    await sendJson("/api/bills", "POST", action);
    try { await load(); } catch { if (alive.current) setError("The bill was saved, but subscriptions could not be reloaded. Reload the latest subscriptions before making another change."); }
  }} /> : <p role="status">Loading your subscriptions…</p>;
}
