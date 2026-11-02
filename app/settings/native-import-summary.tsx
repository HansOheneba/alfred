export type DatasetCoverage = {
  dataset: string;
  status: "supported" | "preserved" | "excluded" | "unavailable";
  reason: string;
  count?: number;
};

export type NativeImportSummary = {
  counts: Record<string, number>;
  additions: Record<string, number>;
  duplicates: number;
  duplicateCounts?: Record<string, number>;
  conflicts: string[];
  coverage: DatasetCoverage[];
  settings: { applied: string[]; preserved: string[]; conflicts: string[] };
};

/** A contradictory server summary must never expose a confirm action. */
export function nativeSummaryBlocksImport(summary?: NativeImportSummary): boolean {
  return !!summary && (summary.conflicts.length > 0 || summary.settings.conflicts.length > 0);
}

const DOMAIN_LABELS: Record<string, string> = {
  accounts: "Accounts", movements: "Money movements", snapshots: "Balance snapshots", transfers: "Transfer links", settlements: "Refund and loan links",
  transactions: "Original transactions", bank_messages: "Bank messages", bankMessages: "Bank messages",
  accounting_states: "Accounts and balances", accountingStates: "Accounts and balances", accounting_events: "Change history", accountingEvents: "Change history",
  budgets: "Budgets", savings_goals: "Savings goals", savingsGoals: "Savings goals", bills: "Bills and renewals", people: "People notes", about_me: "Notebook notes", aboutMe: "Notebook notes",
  payee_rules: "Payee rules", payeeRules: "Payee rules", investments: "Investments", investment_holdings: "Investment holdings", investmentHoldings: "Investment holdings",
  investment_values: "Reported investment values", investmentValues: "Reported investment values", investment_contributions: "Investment contributions", investmentContributions: "Investment contributions",
  messages: "Chat history", loans: "Loans and repayments", label_undo: "Previous corrections", labelUndo: "Previous corrections",
  settings: "Profile and reminder preferences", profile: "Profile preferences", reminderPreferences: "Reminder preferences", reminder_preferences: "Reminder preferences",
  retainedArchives: "Previous imports", importReceipts: "Previous imports", importedSources: "Original records", native: "Other saved data",
  preferred_name: "Preferred name", currency: "Main currency", timezone: "Timezone", communication_preference: "Reply preference", financial_goals: "Financial goals", account_names: "Account names used by SMS collection",
  morning_minute: "Morning reminder time", commute_minute: "Commute reminder time", evening_minute: "Evening reminder time",
  morning_enabled: "Morning reminder enabled", commute_enabled: "Commute reminder enabled", evening_enabled: "Evening reminder enabled",
  "safe-defaults": "Profile preferences", "notification-and-source-controls": "Reminders and account matching", "account-exclusions": "Bank message filters", browserPreferences: "Device preferences", "moneyTracker.native.planning.preferences": "Planning preferences",
  thirdPartyGroups: "Shared money", thirdPartyAudit: "Shared-money history", plans: "Income plans and targets", rules: "Categorisation rules", overrides: "Payment changes", settlementAudit: "Refund and loan history", account_rules: "Account categorisation rules", accountRules: "Account categorisation rules", account_bindings: "Linked accounts", accountBindings: "Linked accounts",
  portfolios: "Portfolios", unrepresentablePositions: "Holdings needing review", undatedValue: "Investment values needing a date", notificationPreferences: "Reminders", "authentication-and-connections": "Passwords and connections", "pending-actions-and-delivery-state": "Unfinished requests", "market-price-cache": "Market prices", "assistant-deployment-guidance": "App configuration", "legacy-unowned-ledger-rows": "Records with no confirmed owner", "source-account-identity": "Original account details", "structured-secrets-and-machine-paths": "Private app information",
};

export function datasetLabel(dataset: string): string {
  const colon = dataset.indexOf(":");
  const path = colon === -1 ? dataset : dataset.slice(0, colon);
  const parts = path.split(".");
  return DOMAIN_LABELS[path] || [...parts].reverse().map((part) => DOMAIN_LABELS[part]).find(Boolean) || "Other saved data";
}

const statusLabels: Record<DatasetCoverage["status"], string> = {
  supported: "Ready to add", preserved: "Saved for later", excluded: "Not included", unavailable: "Unavailable",
};

export function DatasetCoverageList({ coverage }: { coverage: DatasetCoverage[] }) {
  return (
    <dl className="space-y-3 text-xs leading-5">
      {coverage.map((item, index) => <div key={`${item.dataset}-${index}`}><dt className="break-words font-medium text-ink">{datasetLabel(item.dataset)} · {statusLabels[item.status]}{item.count === undefined ? "" : ` · ${item.count.toLocaleString()} ${item.count === 1 ? "record" : "records"}`}</dt><dd className="text-muted">{plainImportMessage(item.reason)}</dd></div>)}
    </dl>
  );
}

function SettingList({ title, fields, danger = false }: { title: string; fields: string[]; danger?: boolean }) {
  if (!fields.length) return null;
  const settingLabel = (field: string) => /Reminder enable flags|delivery markers|notification/i.test(field) ? "Reminders stay unchanged" : /account_names|account-name matching/i.test(field) ? "Bank message matching stays unchanged" : datasetLabel(field);
  return <div className={danger ? "text-danger" : "text-muted"}><h5 className="font-medium">{title}</h5><ul className="mt-1 list-disc space-y-1 pl-5">{[...new Set(fields.map(settingLabel))].map((field, index) => <li key={`${field}-${index}`} className="break-words">{field}{danger ? " needs review." : ""}</li>)}</ul></div>;
}

export function NativeFeatureSummary({ summary, phase = "preview" }: { summary: NativeImportSummary; phase?: "preview" | "receipt" }) {
  const domains = [...new Set([...Object.keys(summary.counts), ...Object.keys(summary.additions)])].filter((domain) => (summary.additions[domain] ?? 0) > 0 || (summary.duplicateCounts?.[domain] ?? 0) > 0 || summary.duplicateCounts === undefined && summary.duplicates > 0 && (summary.counts[domain] ?? 0) > 0);
  const { settings } = summary;
  if (!domains.length && !summary.conflicts.length && !settings.applied.length && !settings.preserved.length && !settings.conflicts.length) return null;
  return (
    <section aria-label="Alfred feature restoration" className="space-y-4 rounded-xl border border-line p-3">
      <h4 className="text-sm font-medium">Other records</h4>
      {domains.length ? (
        <table className="w-full table-fixed text-left text-xs leading-5">
          <caption className="sr-only">{phase === "preview" ? "Records in your file and planned additions" : "Records added by this import"}</caption>
          <thead className="text-muted"><tr><th scope="col" className="w-[43%] pb-2 pr-2 font-normal">Records</th><th scope="col" className="pb-2 pr-2 text-right font-normal">In file</th><th scope="col" className="pb-2 pr-2 text-right font-normal">{phase === "preview" ? "To add" : "Added"}</th><th scope="col" className="pb-2 text-right font-normal">Already saved</th></tr></thead>
          <tbody className="divide-y divide-line">{domains.map((domain) => <tr key={domain}><th scope="row" className="break-words py-2 pr-2 font-medium text-ink">{datasetLabel(domain)}</th><td className="py-2 pr-2 text-right tabular-nums text-muted">{(summary.counts[domain] ?? 0).toLocaleString()}</td><td className="py-2 pr-2 text-right tabular-nums">{(summary.additions[domain] ?? 0).toLocaleString()}</td><td className="py-2 text-right tabular-nums text-muted">{summary.duplicateCounts?.[domain] === undefined ? "—" : summary.duplicateCounts[domain].toLocaleString()}</td></tr>)}</tbody>
        </table>
      ) : <p className="text-xs leading-5 text-muted">No other records to add.</p>}
      <p className="text-xs leading-5 text-muted">{summary.duplicates.toLocaleString()} existing feature record{summary.duplicates === 1 ? "" : "s"} {phase === "preview" ? "will be" : summary.duplicates === 1 ? "was" : "were"} skipped. Existing records stay unchanged.</p>
      {summary.conflicts.length ? <div className="text-xs leading-5 text-danger"><h5 className="font-medium">Some records need review</h5><ul className="mt-1 list-disc space-y-1 pl-5">{summary.conflicts.map((conflict, index) => <li key={`${index}-${conflict}`} className="break-words">{plainImportMessage(conflict)}</li>)}</ul></div> : null}
      {settings.applied.length || settings.preserved.length || settings.conflicts.length ? (
        <section aria-label="Settings coverage" className="space-y-3 border-t border-line pt-3 text-xs leading-5">
          <h4 className="font-medium text-ink">Preferences</h4>
          <SettingList title={phase === "preview" ? "Update default preferences" : "Updated default preferences"} fields={settings.applied} />
          <SettingList title="Keep your current choices" fields={settings.preserved} />
          <SettingList title="Preferences need review" fields={settings.conflicts} danger />
          <p className="text-muted">Importing won’t turn on reminders or connect your accounts.</p>
        </section>
      ) : null}
      {summary.coverage.length ? <details className="border-t border-line pt-3"><summary className="cursor-pointer text-xs font-medium focus-visible:outline-2 focus-visible:outline-accent">What’s included</summary><div className="mt-3"><DatasetCoverageList coverage={summary.coverage} /></div></details> : null}
    </section>
  );
}
import { plainImportMessage } from "@/app/settings/portability-copy";
