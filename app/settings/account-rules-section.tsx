"use client";

import { useEffect, useState, type FormEvent } from "react";

import { Button, Card, Dialog, DialogActions, Field, inputClass } from "@/app/components/ui";
import { Select } from "@/app/components/select";
import { CategoryCombobox } from "@/app/components/category-combobox";
import { Spinner } from "@/app/components/status";
import { categoryList } from "@/lib/finance/categories";
import { useCustomCategories } from "@/app/components/category-catalog";
import { normalizeRuleText, type AccountBinding, type AccountRule, type AccountRuleCommand, type AccountRuleResult } from "@/lib/account-rules/types";
import { accountRuleCommandSchema } from "@/lib/account-rules/schema";
import { loadAccountRulesInputs, type AccountRulesData, type AccountRulesTransport, type RuleAccount } from "./account-rules-data";
export type { AccountRulesData, AccountRulesTransport, RuleAccount } from "./account-rules-data";

class RuleRequestError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}
async function json<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as { ok?: boolean; text?: string; code?: string };
  if (!response.ok || payload.ok === false) throw new RuleRequestError(payload.text || "Account rules could not be loaded or saved.", payload.code);
  return payload as T;
}
const browserTransport: AccountRulesTransport = {
  load: loadAccountRulesInputs,
  async save(command) {
    const response = await fetch("/api/account-rules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) });
    return json<AccountRuleResult>(response);
  },
};

type Form = { id: string | null; accountId: string; merchant: string; category: string; direction: AccountRule["direction"]; all: boolean; active: boolean; priority: number; effectiveFrom?: string };
const emptyForm = (): Form => ({ id: null, accountId: "", merchant: "", category: "", direction: "out", all: false, active: true, priority: 0 });
type Change = { command: AccountRuleCommand; rule?: AccountRule | NonNullable<Extract<AccountRuleCommand, { type: "upsert_rule" }>["rule"]>; binding?: AccountBinding | Extract<AccountRuleCommand, { type: "save_binding" }>["binding"]; title: string };
const directionLabel = (direction?: string) => direction === "in" ? "Incoming" : direction === "any" ? "Incoming or outgoing" : "Outgoing";
const requestId = () => `rule-ui:${crypto.randomUUID()}`;

export function RuleScopeDetails({ rule, accounts }: { rule: NonNullable<Change["rule"]>; accounts: RuleAccount[] }) {
  const account = accounts.find((item) => item.id === rule.accountId);
  return <dl className="space-y-2 text-sm leading-6"><div><dt className="text-xs text-muted">Only this account</dt><dd className="font-medium">{account?.label || "Unavailable account"}</dd></div><div><dt className="text-xs text-muted">Match</dt><dd>{rule.matchMode === "all" ? "Every merchant/text on this account" : `Exactly: “${rule.merchantExact}”`}</dd></div><div><dt className="text-xs text-muted">Direction</dt><dd>{directionLabel(rule.direction)}</dd></div><div><dt className="text-xs text-muted">Category</dt><dd className="break-words font-medium">{rule.category}</dd></div><div><dt className="text-xs text-muted">State</dt><dd>{rule.active === false ? "Disabled" : "Enabled"}</dd></div>{rule.effectiveFrom ? <div><dt className="text-xs text-muted">Applies from</dt><dd className="break-words">{new Date(rule.effectiveFrom).toLocaleDateString()}</dd></div> : null}</dl>;
}

export function AccountRulesSection({ transport = browserTransport, ownerId }: { transport?: AccountRulesTransport; ownerId?: string }) {
  const custom = useCustomCategories();
  const [loaded, setData] = useState<AccountRulesData | null>(null);
  const data = !ownerId || loaded?.state.ownerId === ownerId ? loaded : null;
  const [form, setForm] = useState<Form>(emptyForm);
  const [binding, setBinding] = useState({ accountId: "", provider: "", suffix: "" });
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [change, setChange] = useState<Change | null>(null);
  const [allScopeAcknowledged, setAllScopeAcknowledged] = useState(false);
  const ready = data?.availability === "ready";

  useEffect(() => {
    let active = true;
    void transport.load(ownerId).then((next) => { if (active) { setData(next); setError(""); } }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Account rules could not be loaded."); });
    return () => { active = false; };
  }, [transport, refresh, ownerId]);

  function stage(next: Change) { setChange(next); setAllScopeAcknowledged(false); setError(""); setNotice(""); }

  function reviewRule(event: FormEvent) {
    event.preventDefault(); if (!ready || !data || busy) return;
    const rule = { id: form.id ?? crypto.randomUUID(), accountId: form.accountId, matchMode: form.all ? "all" as const : "exact" as const, merchantExact: form.all ? null : form.merchant.trim(), direction: form.direction, category: form.category.trim(), active: form.active, priority: form.priority, effectiveFrom: form.effectiveFrom ?? new Date().toISOString() };
    const command: AccountRuleCommand = { type: "upsert_rule", expectedRevision: data.state.revision, requestId: requestId(), rule, ...(form.all ? { confirmAllScope: true } : {}) };
    const checked = accountRuleCommandSchema.safeParse(command);
    if (!checked.success || !data.accounts.some((account) => account.id === rule.accountId)) { setError(checked.success ? "Choose the account this rule applies to." : checked.error.issues[0]?.message || "Check this rule."); return; }
    if (!form.id && data.state.rules.some((item) => item.accountId === rule.accountId && item.matchMode === rule.matchMode && item.direction === rule.direction && (rule.matchMode === "all" || item.merchantExact !== null && normalizeRuleText(item.merchantExact) === normalizeRuleText(rule.merchantExact!)))) { setError("A rule already has these account, merchant and direction conditions. Edit that saved rule below instead."); return; }
    stage({ command: checked.data, rule, title: form.id ? "Review rule changes" : "Review this account rule" });
  }

  function reviewBinding(event: FormEvent) {
    event.preventDefault(); if (!ready || !data || busy) return;
    const account = data.accounts.find((item) => item.id === binding.accountId);
    if (!account) { setError("Choose the account for these bank messages."); return; }
    const value = { id: crypto.randomUUID(), accountId: account.id, provider: binding.provider.trim(), accountSuffix: binding.suffix.trim(), currency: account.currency, active: true };
    const command: AccountRuleCommand = { type: "save_binding", expectedRevision: data.state.revision, requestId: requestId(), binding: value };
    const checked = accountRuleCommandSchema.safeParse(command);
    if (!checked.success) { setError(checked.error.issues[0]?.message || "Check this account source."); return; }
    stage({ command: checked.data, binding: value, title: "Review bank text account link" });
  }

  async function confirmChange() {
    if (!change || !data || busy) return;
    const broad = change.rule?.matchMode === "all" && (change.command.type === "upsert_rule" || change.command.type === "set_rule_active" && change.command.active);
    if (broad && !allScopeAcknowledged) return;
    setBusy(true); setError("");
    try {
      const result = await transport.save(change.command);
      if (result.availability !== "ready") throw new Error("Rules are not available yet. Nothing was changed.");
      setData({ ...data, ...result }); setChange(null); setForm(emptyForm()); setBinding({ accountId: "", provider: "", suffix: "" });
      setNotice("Rule saved. Your manual categories are kept. Transactions still need the usual review.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The account rule could not be saved.");
      if (cause && typeof cause === "object" && "code" in cause && ["stale", "conflict"].includes(String(cause.code))) setChange(null);
    } finally { setBusy(false); }
  }

  function toggleRule(rule: AccountRule) {
    if (!data || busy) return;
    const active = !rule.active;
    stage({ title: active ? "Review enabling this rule" : "Review disabling this rule", rule: { ...rule, active }, command: { type: "set_rule_active", ruleId: rule.id, active, expectedRevision: data.state.revision, requestId: requestId(), ...(active && rule.matchMode === "all" ? { confirmAllScope: true } : {}) } });
  }

  const broad = change?.rule?.matchMode === "all" && (change.command.type === "upsert_rule" || change.command.type === "set_rule_active" && change.command.active);
  return <Card title="Account-specific categorisation" action={<Button size="sm" onClick={() => { setRefresh((value) => value + 1); setNotice(""); }} disabled={busy}>Refresh rules</Button>}>
    <div className="space-y-5">
      <p className="text-sm leading-6 text-muted">Choose an account and merchant to categorise matching transactions. Your manual categories are kept, and transactions still need the usual review.</p>
      <p className="text-xs leading-5 text-muted">If rules disagree, the existing category is kept.</p>
      {!data ? <p className="text-sm text-muted">Loading account rules…</p> : !ready ? <p className="rounded-xl border border-line p-3 text-sm text-muted">Rules are not available yet. Your existing data has not changed.</p> : !data.accounts.length ? <p className="text-sm text-muted">Add or import an account before creating a rule.</p> : null}
      <form onSubmit={reviewRule} className="grid gap-3 sm:grid-cols-2">
        <Field label="Account"><Select className={inputClass} required disabled={!ready || busy} value={form.accountId} onChange={(event) => setForm({ ...form, accountId: event.target.value })}><option value="">Choose one account</option>{data?.accounts.map((account) => <option key={account.id} value={account.id}>{account.label} · {account.currency}</option>)}</Select></Field>
        <Field label="Direction"><Select className={inputClass} disabled={!ready || busy} value={form.direction} onChange={(event) => setForm({ ...form, direction: event.target.value as Form["direction"] })}><option value="out">Outgoing</option><option value="in">Incoming</option><option value="any">Incoming or outgoing</option></Select></Field>
        <Field label="Exact merchant or text" hint="Match the whole name or text. Capitalisation and extra spaces do not matter."><input className={inputClass} required={!form.all} maxLength={2000} disabled={!ready || busy || form.all} value={form.merchant} onChange={(event) => setForm({ ...form, merchant: event.target.value })} /></Field>
        <Field label="Category"><CategoryCombobox aria-label="Category" required maxLength={120} options={[...categoryList("expense", custom), ...categoryList("income", custom)]} disabled={!ready || busy} value={form.category} onValueChange={(category) => setForm({ ...form, category })} /></Field>
        <label className="flex items-start gap-2 text-xs leading-5 text-muted sm:col-span-2"><input type="checkbox" checked={form.all} disabled={!ready || busy} onChange={(event) => setForm({ ...form, all: event.target.checked })} className="mt-1 accent-[var(--accent)]" /><span>Apply to every merchant/text on this one account. This broad scope needs an extra confirmation.</span></label>
        <div className="alfred-buttonGroup--mobileStack flex flex-wrap gap-2 sm:col-span-2"><Button className="alfred-button--mobileFull" type="submit" disabled={!ready || busy}>{form.id ? "Review changes" : "Review rule"}</Button>{form.id ? <Button variant="ghost" className="alfred-button--mobileFull" onClick={() => setForm(emptyForm())} disabled={busy}>Cancel edit</Button> : null}</div>
      </form>
      <section aria-label="Saved account rules" className="space-y-3 border-t border-line pt-4"><h3 className="text-sm font-medium">Saved rules</h3>{data && !data.state.rules.length ? <p className="text-xs text-muted">No account-specific rules saved.</p> : null}<ul className="space-y-3">{data?.state.rules.map((rule) => <li key={rule.id} className="space-y-3 rounded-xl border border-line p-3"><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="break-words text-sm font-medium">{rule.category} · {rule.active ? "Enabled" : "Disabled"}</h4></div><RuleScopeDetails rule={rule} accounts={data.accounts} /><div className="flex gap-2"><Button size="sm" disabled={!ready || busy} onClick={() => { setForm({ id: rule.id, accountId: rule.accountId, merchant: rule.merchantExact ?? "", category: rule.category, direction: rule.direction, all: rule.matchMode === "all", active: rule.active, priority: rule.priority, effectiveFrom: rule.effectiveFrom }); setError(""); setNotice("The rule is loaded in the editor above. Review its scope before saving."); }}>Edit rule</Button><Button size="sm" disabled={!ready || busy} onClick={() => toggleRule(rule)}>{rule.active ? "Disable rule" : "Enable rule"}</Button></div></li>)}</ul></section>
      <details className="border-t border-line pt-4"><summary className="cursor-pointer text-sm font-medium focus-visible:outline-2 focus-visible:outline-accent">Match bank messages to accounts</summary><div className="mt-3 space-y-4"><p className="text-xs leading-5 text-muted">Use the sender and account-ending digits to match a bank message. The sender alone isn’t enough. If more than one account matches, the message stays unassigned.</p><form onSubmit={reviewBinding} className="grid gap-3 sm:grid-cols-2"><Field label="Account"><Select className={inputClass} required disabled={!ready || busy} value={binding.accountId} onChange={(event) => setBinding({ ...binding, accountId: event.target.value })}><option value="">Choose one account</option>{data?.accounts.map((account) => <option key={account.id} value={account.id}>{account.label} · {account.currency}</option>)}</Select></Field><Field label="Bank message sender" hint="Use the name shown on your bank messages, such as gcb or momo."><input className={inputClass} required maxLength={120} disabled={!ready || busy} value={binding.provider} onChange={(event) => setBinding({ ...binding, provider: event.target.value })} /></Field><Field label="Account ending" hint="Exactly 3 or 4 digits present in the source text."><input className={inputClass} required pattern="[0-9]{3,4}" maxLength={4} inputMode="numeric" disabled={!ready || busy} value={binding.suffix} onChange={(event) => setBinding({ ...binding, suffix: event.target.value })} /></Field><div className="flex items-end"><Button className="alfred-button--mobileFull" type="submit" disabled={!ready || busy}>Review account link</Button></div></form><ul className="space-y-2 text-xs leading-5">{data?.state.bindings.map((item) => <li key={item.id} className="rounded-xl border border-line p-3"><p className="break-words font-medium">{item.provider} · ending {item.accountSuffix} · {item.currency} → {data.accounts.find((account) => account.id === item.accountId)?.label || "Unavailable account"}</p><p className="text-muted">{item.active ? "Enabled" : "Disabled"}</p><Button size="sm" className="mt-2" disabled={!ready || busy} onClick={() => stage({ title: item.active ? "Review disabling this account link" : "Review enabling this account link", binding: { ...item, active: !item.active }, command: { type: "save_binding", expectedRevision: data.state.revision, requestId: requestId(), binding: { id: item.id, accountId: item.accountId, provider: item.provider, accountSuffix: item.accountSuffix, currency: item.currency, active: !item.active } } })}>{item.active ? "Disable link" : "Enable link"}</Button></li>)}</ul></div></details>
      <p role="status" className="text-xs leading-5 text-muted">{notice}</p>{error && !change ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    </div>
    <Dialog open={!!change} onClose={() => busy ? undefined : setChange(null)} title={change?.title ?? "Review account rule"} dismissible={!busy}>
      {change?.rule && data ? <RuleScopeDetails rule={change.rule} accounts={data.accounts} /> : null}
      {change?.binding && data ? <dl className="space-y-2 text-sm"><div><dt className="text-xs text-muted">Only this account</dt><dd>{data.accounts.find((account) => account.id === change.binding!.accountId)?.label || "Unavailable account"}</dd></div><div><dt className="text-xs text-muted">Bank message details</dt><dd>{change.binding.provider} · ending {change.binding.accountSuffix} · {change.binding.currency}</dd></div><div><dt className="text-xs text-muted">State</dt><dd>{change.binding.active ? "Enabled" : "Disabled"}</dd></div></dl> : null}
      {broad ? <label className="mt-4 flex items-start gap-2 text-sm leading-6"><input type="checkbox" checked={allScopeAcknowledged} onChange={(event) => setAllScopeAcknowledged(event.target.checked)} disabled={busy} className="mt-1.5 accent-[var(--accent)]" /><span>I explicitly want every merchant/text in this direction on this one account. Other accounts are excluded.</span></label> : null}
      {error ? <p role="alert" className="mt-3 text-sm text-danger">{error}</p> : null}
      <DialogActions className="mt-5"><Button variant="ghost" className="alfred-button--mobileFull" onClick={() => setChange(null)} disabled={busy}>Cancel</Button><Button variant="primary" className="alfred-button--mobileFull" onClick={() => void confirmChange()} disabled={busy || !!broad && !allScopeAcknowledged} aria-busy={busy}>{busy ? <Spinner /> : null}{change?.binding ? "Confirm account link" : "Confirm rule"}</Button></DialogActions>
    </Dialog>
  </Card>;
}
