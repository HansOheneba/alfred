"use client";

import { Button } from "@/app/components/ui";
import type { PendingImportDetail, PendingImportDomain } from "@/app/settings/pending-import-types";
import { datasetLabel } from "@/app/settings/native-import-summary";
import { plainImportMessage } from "@/app/settings/portability-copy";

type Row = Record<string, unknown>;
type SavedField = { label: string; value: string };
type SavedRelationship = { label: string; sourceId: string; fingerprint?: string; description?: string; date?: string; amount?: string };
export type PendingReadableRecord = { id: string; title: string; fields: SavedField[]; relationships: SavedRelationship[] };
const object = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);
const scalar = (value: unknown): string => value === null ? "Not recorded" : typeof value === "boolean" ? value ? "Yes" : "No" : typeof value === "string" || typeof value === "number" ? String(value) : "Included in your download";
const label = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").replace(/^./, (char) => char.toUpperCase());
const MAX_READABLE_RECORDS = 20;
const money = (value: unknown, currency: string) => typeof value === "number" && Number.isSafeInteger(value) ? currency ? `${currency} ${value < 0 ? "-" : ""}${Math.floor(Math.abs(value) / 100)}.${String(Math.abs(value) % 100).padStart(2, "0")}` : "Amount included in your download" : scalar(value);
function readableDate(value: unknown, timezone = "UTC"): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "Date not provided";
  try { return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", ...(value.includes("T") ? { timeStyle: "short" as const } : {}), timeZone: timezone }).format(new Date(value)); }
  catch { return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value)); }
}
const technicalField = (key: string) => /(?:^id$|Id$|_id$|fingerprint|hash|schema|revision|namespace|request|provenance|sourceKind|sourceStatus|rowNumber)/i.test(key);
const reminderPreferences = (dataset: string) => /(?:planning\.preferences|notificationPreferences)(?:\.|$)/.test(dataset);
export const isPortfolioWrapper = (dataset: string) => dataset === "moneyTracker.portfolios";
export function pendingDomainReason(domain: PendingImportDomain): string {
  return reminderPreferences(domain.dataset) ? "These reminder choices don’t have a matching feature in Alfred yet. They stay saved, and no reminders have been turned on." : plainImportMessage(domain.reason);
}

/** Resolve only own properties, starting with the longest actual dataset name. */
export function pendingDomainValue(datasets: Record<string, unknown>, path: string | string[]): { found: boolean; value?: unknown } {
  if (Array.isArray(path)) {
    let value: unknown = datasets;
    for (const key of path) {
      if (Array.isArray(value) && /^(0|[1-9]\d*)$/.test(key) && Number.isSafeInteger(Number(key)) && Object.hasOwn(value, key)) value = value[Number(key)];
      else if (!["__proto__", "prototype", "constructor"].includes(key) && object(value) && Object.hasOwn(value, key)) value = value[key];
      else return { found: false };
    }
    return { found: true, value };
  }
  const root = Object.keys(datasets).filter((key) => path === key || path.startsWith(`${key}.`)).sort((left, right) => right.length - left.length)[0];
  if (!root) return { found: false };
  let value = datasets[root];
  const suffix = path.slice(root.length).replace(/^\./, "");
  if (!suffix) return { found: true, value };
  for (const key of suffix.split(".")) {
    if (Array.isArray(value) && /^(0|[1-9]\d*)$/.test(key) && Number.isSafeInteger(Number(key)) && Object.hasOwn(value, key)) value = value[Number(key)];
    else if (!["__proto__", "prototype", "constructor"].includes(key) && object(value) && Object.hasOwn(value, key)) value = value[key];
    else return { found: false };
  }
  return { found: true, value };
}

const sourceIndexes = new WeakMap<object, Map<string, Row>>();
function sourceReference(value: unknown, datasets: Record<string, unknown>): { description?: string; date?: string } {
  if (typeof value !== "string" || !Array.isArray(datasets.movements)) return {};
  let index = sourceIndexes.get(datasets.movements);
  if (!index) {
    index = new Map();
    for (const item of datasets.movements) if (object(item)) for (const id of [item.id, item.sourceId, object(item.importProvenance) ? item.importProvenance.sourceId : undefined]) if (typeof id === "string" && !index.has(id)) index.set(id, item);
    sourceIndexes.set(datasets.movements, index);
  }
  const movement = index.get(value);
  return object(movement) ? { ...(typeof movement.description === "string" ? { description: movement.description } : {}), ...(typeof movement.date === "string" ? { date: movement.date } : {}) } : {};
}

function rows(value: unknown): [string, unknown][] {
  return Array.isArray(value) ? value.map((item, index) => [String(index + 1), item]) : object(value) ? Object.entries(value) : [["value", value]];
}

/** Explicit readable descriptions of source meanings; these never activate a destination feature. */
export function describePendingRecords(dataset: string, value: unknown, detail: Pick<PendingImportDetail, "datasets" | "manifest" | "item">): { kind: string; total: number; records: PendingReadableRecord[] } {
  const currency = typeof detail.manifest.currency === "string" ? detail.manifest.currency : "";
  if (isPortfolioWrapper(dataset)) {
    const portfolios = object(value) && Array.isArray(value.portfolios) ? value.portfolios : [];
    const records = portfolios.slice(0, MAX_READABLE_RECORDS).map((entry, index): PendingReadableRecord => {
      const raw = object(entry) ? entry : {};
      const fields: SavedField[] = [];
      for (const [key, title] of [["currency", "Currency"], ["market", "Market"]]) if (typeof raw[key] === "string") fields.push({ label: title, value: raw[key] as string });
      const provider = typeof raw.provider === "string" ? raw.provider : object(raw.provider) && typeof raw.provider.name === "string" ? raw.provider.name : undefined;
      if (provider) fields.push({ label: "Provider", value: provider });
      if (Object.hasOwn(raw, "reportedValue")) fields.push({ label: "Reported value", value: money(raw.reportedValue, typeof raw.currency === "string" ? raw.currency : currency) });
      if (typeof raw.marketAsOf === "string") fields.push({ label: "Value recorded", value: readableDate(raw.marketAsOf) });
      fields.push({ label: "Complete holdings and history", value: "Included in your download" });
      return { id: `portfolio:${index}`, title: typeof raw.name === "string" ? raw.name : `Portfolio ${index + 1}`, fields, relationships: [] };
    });
    return { kind: portfolios.length ? "Saved portfolios" : "No portfolio holdings in this download", total: portfolios.length, records };
  }
  const isThirdParty = /thirdPartyGroups|thirdPartyAudit/.test(dataset);
  const isPlan = /(?:\.plans|incomeIntent|income-plan)(?:\.|$)/.test(dataset);
  const isRule = /(?:\.rules|payeeRules|payee_rules)(?:\.|$)/.test(dataset);
  if (reminderPreferences(dataset)) {
    const preferences = object(value) && object(value.preferences) ? value.preferences : object(value) ? value : {};
    const fields: SavedField[] = [];
    for (const [name, title] of [["paymentPrompts", "Payment reminders"], ["reminders", "Bill reminders"], ["weekly", "Weekly spending summary"]]) {
      if (typeof preferences[name] === "boolean") fields.push({ label: title, value: preferences[name] ? "On in the original app" : "Off in the original app" });
    }
    if (!fields.length) fields.push({ label: "Original choices", value: "Included in your download" });
    fields.push({ label: "In Alfred", value: "These choices stay saved. No reminders have been turned on." });
    return { kind: "Reminder choices", total: 1, records: [{ id: "saved-reminder-choices", title: "Saved reminder choices", fields, relationships: [] }] };
  }
  const values = rows(value);
  const records = values.slice(0, MAX_READABLE_RECORDS).map(([key, entry], index): PendingReadableRecord => {
    const raw = object(entry) ? entry : { value: entry };
    const group = isThirdParty && object(raw.group) ? raw.group : raw;
    const id = scalar(group.id ?? raw.id ?? key);
    const fields: SavedField[] = [], relationships: SavedRelationship[] = [];
    function field(name: string, fieldLabel = label(name), amount = false, source: Row = raw) {
      if (Object.hasOwn(source, name)) fields.push({ label: fieldLabel, value: amount ? money(source[name], currency) : scalar(source[name]) });
    }
    if (isThirdParty) {
      if (Object.hasOwn(raw, "event")) fields.push({ label: "Change recorded", value: raw.event === "create" ? "Added" : raw.event === "remove" ? "Removed" : scalar(raw.event) });
      if (typeof raw.at === "string") fields.push({ label: "Changed", value: readableDate(raw.at) });
      if (typeof group.createdAt === "string") fields.push({ label: "Created", value: readableDate(group.createdAt) });
      if (Array.isArray(group.entries)) for (const item of group.entries) {
        if (!object(item)) continue;
        const sourceId = typeof item.identity === "string" ? item.identity : typeof item.id === "string" ? item.id : "Unidentified source";
        const exactSource = sourceReference(sourceId, detail.datasets);
        relationships.push({ label: item.direction === "in" ? "Received for someone else" : item.direction === "out" ? "Paid for someone else" : "Shared money", sourceId,
          ...(typeof item.sourceFingerprint === "string" ? { fingerprint: item.sourceFingerprint } : {}),
          description: typeof item.description === "string" ? item.description : exactSource.description,
          date: typeof item.date === "string" ? item.date : exactSource.date,
          ...(Object.hasOwn(item, "principal") ? { amount: money(item.principal, currency) } : {}),
        });
      }
      fields.push({ label: "In Alfred", value: "These shared-money links are saved. They don’t change your personal spending." });
    } else if (isPlan) {
      field("expectedIncome", "Expected income", true); field("keepAside", "Saving target", true); field("investmentTarget", "Investment target", true); field("limit", "Spending target", true); field("focus", "Focus");
      if (Object.hasOwn(raw, "repeat")) fields.push({ label: "Repeat plan", value: `${scalar(raw.repeat)}. Not scheduled in Alfred.` });
      if (object(raw.categoryLimits)) for (const [category, amount] of Object.entries(raw.categoryLimits)) fields.push({ label: `Category limit: ${category}`, value: money(amount, currency) });
      fields.push({ label: "In Alfred", value: "These are plans, not income received or money already saved or invested." });
    } else if (isRule) {
      if (Object.hasOwn(raw, "accountId") || Object.hasOwn(raw, "account")) {
        const accountId = raw.accountId ?? raw.account;
        const account = Array.isArray(detail.datasets.accounts) ? detail.datasets.accounts.find((item) => object(item) && item.id === accountId) : undefined;
        fields.push({ label: "Account", value: object(account) && typeof account.label === "string" && account.label.trim() ? account.label : "Original account (included in download)" });
      }
      field("description", "Merchant");
      if (Object.hasOwn(raw, "direction")) fields.push({ label: "Payments", value: raw.direction === "out" ? "Money out" : raw.direction === "in" ? "Money in" : "Money in and out" });
      field("category", "Category"); field("active", "Enabled in the original app");
      fields.push({ label: "In Alfred", value: "The original conditions are saved. Check support and review the rule before enabling it." });
    } else {
      for (const [name, item] of Object.entries(raw).filter(([name]) => !technicalField(name)).slice(0, 16)) if (item === null || typeof item !== "object") fields.push({ label: label(name.replace(/Minor$/, "")), value: /(?:Minor|principal)$/.test(name) ? money(item, currency) : /(?:At|_at|Date|_date)$/.test(name) ? readableDate(item) : scalar(item) });
      for (const name of ["accountId", "movementId", "transactionId", "sourceId", "investmentId", "groupId"]) if (typeof raw[name] === "string") {
        const relationLabel = name === "accountId" ? "Linked account" : name === "investmentId" ? "Linked investment" : name === "groupId" ? "Shared-money group" : "Linked payment";
        const account = name === "accountId" && Array.isArray(detail.datasets.accounts) ? detail.datasets.accounts.find((value) => object(value) && value.id === raw[name]) : undefined;
        const resolved = { ...sourceReference(raw[name], detail.datasets), ...(object(account) && typeof account.label === "string" ? { description: account.label } : {}) };
        if (resolved.description?.trim() || resolved.date) relationships.push({ label: relationLabel, sourceId: raw[name] as string, ...resolved });
      }
      if (!fields.length) fields.push({ label: "Saved details", value: "The complete record is included in your download." });
    }
    return { id: `${id}:${index}`, title: isThirdParty ? typeof group.label === "string" ? group.label : `Shared-money group ${index + 1}` : isPlan ? /^\d{4}-(0[1-9]|1[0-2])$/.test(String(raw.month ?? key)) ? `Plan for ${new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${raw.month ?? key}-01T00:00:00Z`))}` : `Plan ${index + 1}` : isRule ? typeof raw.description === "string" ? raw.description : `Categorisation rule ${index + 1}` : typeof raw.name === "string" ? raw.name : typeof raw.label === "string" ? raw.label : `Saved record ${index + 1}`, fields, relationships };
  });
  return { kind: isThirdParty ? "Shared-money payments" : isPlan ? "Income and spending plans" : isRule ? "Categorisation rules" : "Saved details", total: values.length, records };
}

/** Verification helper; product screens expose complete data through the ZIP download. */
export function PendingRawJson({ value }: { value: unknown }) {
  return <pre tabIndex={0} className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-bg p-3 font-mono text-xs leading-5 text-ink" aria-label="Exact saved JSON">{JSON.stringify(value, null, 2) ?? "null"}</pre>;
}

const statusLabels: Record<PendingImportDomain["status"], string> = { awaiting_support: "Awaiting support", review_required: "Needs review", source_evidence: "Original records" };
const totalCounts = (counts: Record<string, number>) => Object.values(counts).reduce((sum, count) => sum + (Number.isSafeInteger(count) && count > 0 ? count : 0), 0);

export function PendingImportDetails({ detail, onDownload, busy = false }: { detail: PendingImportDetail; onDownload: () => void; busy?: boolean }) {
  const { item } = detail;
  const timezone = typeof detail.manifest.timezone === "string" ? detail.manifest.timezone : "UTC";
  const exportedAt = readableDate(detail.manifest.exportedAt, timezone);
  return (
    <section aria-label="Saved import details" className="space-y-4">
      <div className="rounded-xl border border-line p-4">
        <h4 className="text-sm font-medium">Saved records</h4>
        <p className="mt-2 text-xs leading-5 text-muted">Your records and their links are saved. Checking support won’t change anything. You’ll review and confirm any additions.</p>
        <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
          {[["From", item.sourceApp === "money-tracker" ? "Money Tracker" : item.sourceApp === "alfred" ? "Alfred" : "Another finance app"], ["Downloaded", exportedAt], ["Imported", readableDate(item.importedAt, timezone)]].map(([name, value]) => <div key={name}><dt className="font-medium">{name}</dt><dd className="mt-1 text-muted">{value}</dd></div>)}
        </dl>
        <div className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-3 text-xs">
          <p><span className="block font-medium">{totalCounts(item.activeCounts.accounting).toLocaleString()} money records added</span></p>
          <p><span className="block font-medium">{totalCounts(item.activeCounts.native).toLocaleString()} other records added</span></p>
        </div>
        {item.undone ? <p className="mt-3 text-xs text-muted">This import was undone. Your original records are still available to download.</p> : null}
        <Button className="mt-4" onClick={onDownload} disabled={busy}>Download full data</Button>
      </div>
      {item.pendingDomains.map((domain, index) => {
        const resolved = pendingDomainValue(detail.datasets, domain.path ?? domain.dataset);
        const readable = resolved.found ? describePendingRecords(domain.dataset, resolved.value, detail) : null;
        const savedCount = isPortfolioWrapper(domain.dataset) ? readable?.total ?? null : domain.count;
        return <section key={`${domain.dataset}:${index}`} aria-label={datasetLabel(domain.dataset)} className="space-y-3 rounded-xl border border-line p-4">
          <div><p className="text-xs font-medium text-accent">{statusLabels[domain.status]}</p><h5 className="mt-1 break-words text-sm font-medium">{datasetLabel(domain.dataset)}</h5><p className="mt-2 text-xs leading-5 text-muted">{pendingDomainReason(domain)}</p>{savedCount === null ? null : <p className="mt-2 text-xs text-muted">{savedCount.toLocaleString()} saved {savedCount === 1 ? "record" : "records"}</p>}</div>
          {readable ? <>
            <p className="text-xs font-medium">{readable.kind}</p>
            {readable.total > MAX_READABLE_RECORDS ? <p className="text-xs text-muted">Showing the first {MAX_READABLE_RECORDS} of {readable.total.toLocaleString()} records. Your download includes every record.</p> : null}
            <div className="space-y-3">{readable.records.map((record) => <article key={record.id} className="space-y-3 rounded-xl bg-bg p-3"><h6 className="break-words text-sm font-medium">{record.title}</h6><dl className="space-y-2 text-xs leading-5">{record.fields.map((field, fieldIndex) => <div key={`${field.label}:${fieldIndex}`}><dt className="font-medium">{field.label}</dt><dd className="whitespace-pre-wrap break-words text-muted">{field.value}</dd></div>)}</dl>{record.relationships.length ? <div><p className="text-xs font-medium">Linked payments</p><ul className="mt-2 space-y-3 text-xs leading-5">{record.relationships.map((relationship, relationIndex) => <li key={`${relationship.sourceId}:${relationIndex}`} className="border-l-2 border-line pl-3"><p className="font-medium">{relationship.label}{relationship.amount ? ` · ${relationship.amount}` : ""}</p>{relationship.description ? <p className="break-words text-muted">{relationship.description}</p> : null}{relationship.date ? <p className="text-muted">{readableDate(relationship.date, timezone)}</p> : null}</li>)}</ul></div> : null}</article>)}</div>
          </> : <p className="text-xs leading-5 text-muted">The complete records are included in your download.</p>}
        </section>;
      })}
      {detail.redactions.length ? <p className="text-xs leading-5 text-muted">Passwords, connections and private app information are excluded.</p> : null}
    </section>
  );
}
