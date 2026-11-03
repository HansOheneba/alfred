"use client";

import { useReducer } from "react";

import { Button, Card } from "@/app/components/ui";
import { MAC_PROVIDER_SENDERS, MAC_SETUP_STEPS, type MacProviderSender } from "@/app/settings/bank-section";

const sampleAccounts = {
  expected: { name: "Taylor Example", email: "taylor@example.invalid" },
  other: { name: "Jordan Example", email: "jordan@example.invalid" },
} as const;

export type MacSetupPreviewState = {
  stage: 1 | 2 | 3 | "complete";
  account: "expected" | "other";
  accountReviewed: boolean;
  permissionReviewed: boolean;
  providers: MacProviderSender[];
  newAlertsAcknowledged: boolean;
  error: string | null;
};
export type MacSetupPreviewAction =
  | { type: "account"; account: "expected" | "other" }
  | { type: "review-account"; value: boolean }
  | { type: "review-permission"; value: boolean }
  | { type: "provider"; id: MacProviderSender }
  | { type: "new-alerts"; value: boolean }
  | { type: "next" }
  | { type: "back" }
  | { type: "reset" };

export function createMacSetupPreviewState(): MacSetupPreviewState {
  return { stage: 1, account: "expected", accountReviewed: false, permissionReviewed: false, providers: [], newAlertsAcknowledged: false, error: null };
}

/** Fictional state only: no account request, credential, OS permission or capture command. */
export function macSetupPreviewReducer(state: MacSetupPreviewState, action: MacSetupPreviewAction): MacSetupPreviewState {
  if (action.type === "reset") return createMacSetupPreviewState();
  if (action.type === "account") return { ...createMacSetupPreviewState(), account: action.account };
  if (action.type === "review-account") return state.stage === 1 ? { ...state, accountReviewed: state.account === "expected" && action.value, error: null } : state;
  if (action.type === "review-permission") return state.stage === 2 ? { ...state, permissionReviewed: action.value, error: null } : state;
  if (action.type === "provider") {
    if (state.stage !== 3 || !MAC_PROVIDER_SENDERS.some((provider) => provider.id === action.id)) return state;
    return { ...state, providers: state.providers.includes(action.id) ? state.providers.filter((id) => id !== action.id) : [...state.providers, action.id], error: null };
  }
  if (action.type === "new-alerts") return state.stage === 3 ? { ...state, newAlertsAcknowledged: action.value, error: null } : state;
  if (action.type === "back") {
    if (state.stage === 2) return { ...state, stage: 1, error: null };
    if (state.stage === 3) return { ...state, stage: 2, error: null };
    return state;
  }
  if (state.stage === "complete") return state;
  if (state.account !== "expected" || !state.accountReviewed) return { ...state, error: "Review the expected sample account before continuing." };
  if (state.stage === 1) return { ...state, stage: 2, error: null };
  if (!state.permissionReviewed) return { ...state, error: "Review the sample permission explanation before continuing." };
  if (state.stage === 2) return { ...state, stage: 3, error: null };
  if (state.providers.length === 0 || !state.providers.every((id) => MAC_PROVIDER_SENDERS.some((provider) => provider.id === id))) return { ...state, error: "Choose at least one reviewed sample provider." };
  if (!state.newAlertsAcknowledged) return { ...state, error: "Confirm that this sample starts with new alerts only." };
  return { ...state, stage: "complete", error: null };
}

export function MacSetupPreview() {
  const [state, dispatch] = useReducer(macSetupPreviewReducer, undefined, createMacSetupPreviewState);
  const account = sampleAccounts[state.account];
  const canContinue = state.stage === 1 ? state.account === "expected" && state.accountReviewed : state.stage === 2 ? state.permissionReviewed : state.providers.length > 0 && state.newAlertsAcknowledged;
  return (
    <Card title="Try the fictional Mac setup" action={<span className="rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium text-muted">Sample only</span>}>
      <p className="text-sm leading-6 text-muted">A walkthrough of the three steps, using a made-up account. Nothing here connects, grants access or starts capture.</p>
      <ol className="mt-5 grid grid-cols-3 gap-2" aria-label="Sample setup progress">
        {["Account", "Messages", "Providers"].map((label, index) => {
          const current = state.stage === index + 1;
          const passed = state.stage === "complete" || state.stage > index + 1;
          return <li key={label} aria-current={current ? "step" : undefined} className={`flex min-w-0 items-center gap-2 rounded-xl border px-2.5 py-3 text-xs ${current ? "border-accent bg-accent-soft text-accent" : "border-line bg-bg text-muted"}`}><span className={`grid size-5 shrink-0 place-items-center rounded-full text-[10px] ${current || passed ? "bg-accent text-[var(--accent-ink)]" : "bg-surface-2"}`} aria-hidden="true">{passed ? "✓" : index + 1}</span><span>{label}</span></li>;
        })}
      </ol>

      {state.stage === "complete" ? <div className="mt-6 rounded-2xl border border-accent/20 bg-accent-soft p-4" role="status">
        <h3 className="text-base font-medium text-ink">Preview complete</h3>
        <p className="mt-1 text-sm font-medium text-ink">Capture is still off.</p>
        <p className="mt-3 text-sm leading-6 text-muted">No account was connected, no permission was granted, no credential was stored and no app was started.</p>
        <ul className="mt-4 space-y-2 text-xs leading-5 text-muted"><li>Sample account reviewed: {sampleAccounts.expected.name}</li><li>Sample permission explanation reviewed</li><li>Sample providers: {MAC_PROVIDER_SENDERS.filter((provider) => state.providers.includes(provider.id)).map((provider) => provider.label).join(", ")}</li><li>New alerts only; no historical import</li></ul>
        <Button className="mt-5" onClick={() => dispatch({ type: "reset" })}>Start preview again</Button>
      </div> : <div className="mt-6">
        <p className="text-xs font-medium text-accent">Sample step {state.stage} of 3</p>
        <h3 className="mt-2 text-lg font-medium tracking-tight">{MAC_SETUP_STEPS[state.stage - 1].title}</h3>
        <p className="mt-2 text-sm leading-6 text-muted">{MAC_SETUP_STEPS[state.stage - 1].body}</p>

        {state.stage === 1 ? <div className="mt-5 space-y-4">
          <div className="rounded-xl border border-line bg-bg p-4"><p className="text-[11px] font-medium uppercase tracking-wider text-faint">Fictional account</p><p className="mt-2 text-sm font-medium">{account.name}</p><p className="mt-1 break-all text-sm text-muted">{account.email}</p></div>
          {state.account === "other" ? <p className="rounded-xl border border-danger/20 bg-surface-2 p-3 text-sm leading-6 text-danger" role="alert">That is a different sample account. Stop here and choose the expected sample account before continuing.</p> : null}
          <label className="flex items-start gap-3 text-sm leading-6 text-ink"><input type="checkbox" checked={state.accountReviewed} disabled={state.account !== "expected"} onChange={(event) => dispatch({ type: "review-account", value: event.target.checked })} className="mt-1 size-4 shrink-0 accent-[var(--accent)] disabled:opacity-40" /><span>I have checked this sample name and email.</span></label>
          <Button size="sm" variant="ghost" onClick={() => dispatch({ type: "account", account: state.account === "expected" ? "other" : "expected" })}>{state.account === "expected" ? "Show a sample account mismatch" : "Use expected sample account"}</Button>
          <p className="text-xs leading-5 text-faint">This preview never asks you to sign in, enter a password or paste a forwarding key.</p>
        </div> : null}

        {state.stage === 2 ? <div className="mt-5 space-y-4">
          <div className="rounded-xl border border-line bg-bg p-4"><p className="text-xs font-medium text-ink">Mock permission review · no macOS prompt</p><p className="mt-2 text-sm leading-6 text-muted">In real setup, you would review the Mac permission separately. Selecting the box below only records a choice in this fictional page.</p></div>
          <label className="flex items-start gap-3 text-sm leading-6 text-ink"><input type="checkbox" checked={state.permissionReviewed} onChange={(event) => dispatch({ type: "review-permission", value: event.target.checked })} className="mt-1 size-4 shrink-0 accent-[var(--accent)]" /><span>I have reviewed this sample permission explanation.</span></label>
        </div> : null}

        {state.stage === 3 ? <div className="mt-5 space-y-4">
          <fieldset><legend className="mb-2 text-xs font-medium text-muted">Choose sample providers</legend><div className="grid gap-2 sm:grid-cols-2">{MAC_PROVIDER_SENDERS.map((provider) => <label key={provider.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-line bg-bg px-3 py-2 text-sm"><input type="checkbox" checked={state.providers.includes(provider.id)} onChange={() => dispatch({ type: "provider", id: provider.id })} className="size-4 shrink-0 accent-[var(--accent)]" /><span>{provider.label}</span></label>)}</div></fieldset>
          <div className="rounded-xl bg-accent-soft p-3"><p className="text-xs font-medium text-ink">New alerts only</p><p className="mt-1 text-xs leading-5 text-muted">History stays off. The sample has no option to import old Messages.</p></div>
          <label className="flex items-start gap-3 text-sm leading-6 text-ink"><input type="checkbox" checked={state.newAlertsAcknowledged} onChange={(event) => dispatch({ type: "new-alerts", value: event.target.checked })} className="mt-1 size-4 shrink-0 accent-[var(--accent)]" /><span>I understand this sample would begin with new alerts only.</span></label>
        </div> : null}

        {state.error ? <p className="mt-4 text-sm text-danger" role="alert">{state.error}</p> : null}
        <div className="mt-6 flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
          {state.stage > 1 ? <Button variant="ghost" onClick={() => dispatch({ type: "back" })}>Back</Button> : null}
          <Button variant="primary" onClick={() => dispatch({ type: "next" })} disabled={!canContinue}>{state.stage === 3 ? "Finish sample preview" : "Continue sample setup"}</Button>
        </div>
      </div>}
      <p className="mt-5 text-[11px] leading-5 text-faint">Fictional walkthrough only. It makes no account requests, stores no setup data, reads no Messages and sends nothing.</p>
    </Card>
  );
}
