import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { describePendingRecords, pendingDomainValue, PendingImportDetails, PendingRawJson } from "@/app/settings/pending-import-details";
import { PendingDomainList } from "@/app/settings/awaiting-support-section";
import { syntheticPendingDetail } from "./fixtures/portability/pending-detail";
import { createArchive, readArchive, type Datasets } from "@/portability/archive.mjs";

describe("recoverable pending import details", () => {
  it("packages the same complete synthetic pending detail as a valid exact finance ZIP", async () => {
    const detail = syntheticPendingDetail();
    const archive = await readArchive(await createArchive({ sourceApp: "money-tracker", namespace: String(detail.manifest.namespace), timezone: String(detail.manifest.timezone), currency: String(detail.manifest.currency), exportedAt: String(detail.manifest.exportedAt), datasets: detail.datasets as Datasets, coverage: detail.item.pendingDomains.map((domain) => ({ dataset: domain.dataset, status: "preserved", reason: domain.reason, ...(domain.count === null ? {} : { count: domain.count }) })) }));
    expect(archive.datasets).toEqual(detail.datasets); expect(archive.manifest.counts).toEqual(detail.item.savedDatasetCounts); expect(detail.item.activationAvailable).toBe(true);
  });
  it("resolves explicit dataset paths and longest prefixes without traversing prototypes", () => {
    const datasets = { "app.native": { planning: { rules: [{ id: "exact" }] } }, app: { native: "wrong prefix" } };
    expect(pendingDomainValue(datasets, ["app.native", "planning", "rules"])).toEqual({ found: true, value: [{ id: "exact" }] });
    expect(pendingDomainValue(datasets, "app.native.planning.rules")).toEqual({ found: true, value: [{ id: "exact" }] });
    for (const path of ["app.native.__proto__", "app.native.constructor", "app.native.planning.missing"]) expect(pendingDomainValue(datasets, path).found).toBe(false);
    expect(pendingDomainValue(datasets, ["app.native", "__proto__"]).found).toBe(false);
    const retained = { "alfred.native": { retainedArchives: [{ archive: { datasets: { "moneyTracker.native": { planning: { rules: [{ id: "retained-exact" }] } } } } }] } };
    expect(pendingDomainValue(retained, ["alfred.native", "retainedArchives", "0", "archive", "datasets", "moneyTracker.native", "planning", "rules"])).toEqual({ found: true, value: [{ id: "retained-exact" }] });
    expect(pendingDomainValue(retained, ["alfred.native", "retainedArchives", "length"]).found).toBe(false);
  });
  it("shows third-party ownership intent, exact allocation amounts and linked source fingerprints", () => {
    const detail = syntheticPendingDetail(), path = detail.item.pendingDomains[0];
    const data = pendingDomainValue(detail.datasets, path.path ?? path.dataset).value;
    const readable = describePendingRecords(path.dataset, data, detail);
    expect(readable.kind).toBe("Shared-money payments"); expect(readable.total).toBe(1);
    expect(readable.records[0].title).toBe("Fictional shared purchase");
    expect(readable.records[0].relationships).toEqual([
      expect.objectContaining({ label: "Received for someone else", sourceId: "synthetic-funds-in", fingerprint: "synthetic-in-fingerprint", amount: "GHS 125.00" }),
      expect.objectContaining({ label: "Paid for someone else", sourceId: "synthetic-funds-out", fingerprint: "synthetic-out-fingerprint", amount: "GHS 125.00" }),
    ]);
    expect(readable.records[0].fields.find((field) => field.label === "In Alfred")?.value).toContain("don’t change your personal spending");
  });
  it("keeps income intentions, actual progress and repeat activation separate", () => {
    const detail = syntheticPendingDetail(), domain = detail.item.pendingDomains[1];
    const readable = describePendingRecords(domain.dataset, pendingDomainValue(detail.datasets, domain.path ?? domain.dataset).value, detail);
    expect(readable.records[0].title).toBe("Plan for November 2026");
    expect(readable.records[0].fields).toEqual(expect.arrayContaining([
      { label: "Expected income", value: "GHS 5000.00" }, { label: "Saving target", value: "GHS 1000.00" }, { label: "Investment target", value: "GHS 500.00" },
      { label: "Repeat plan", value: "Yes. Not scheduled in Alfred." },
    ]));
    expect(readable.records[0].fields.find((field) => field.label === "In Alfred")?.value).toContain("plans, not income received");
  });
  it("makes exact account/merchant/direction matching readable without enabling a broader rule", () => {
    const detail = syntheticPendingDetail(), domain = detail.item.pendingDomains[2];
    const readable = describePendingRecords(domain.dataset, pendingDomainValue(detail.datasets, domain.path ?? domain.dataset).value, detail);
    expect(readable.records[0].fields).toEqual(expect.arrayContaining([
      { label: "Account", value: "Original account (included in download)" }, { label: "Merchant", value: "fictional market merchant" }, { label: "Payments", value: "Money out" }, { label: "Category", value: "Food" }, { label: "Enabled in the original app", value: "Yes" },
    ]));
    expect(readable.records[0].fields.find((field) => field.label === "In Alfred")?.value).toContain("review the rule before enabling");
    const account = (detail.datasets.accounts as { id: string; label: string }[])[0];
    const linked = describePendingRecords(domain.dataset, [{ accountId: account.id, description: "Exact merchant" }], detail);
    expect(linked.records[0].fields).toContainEqual({ label: "Account", value: account.label });
  });
  it("shows curated reminder choices without technical keys, nested values or implied activation", () => {
    const detail = syntheticPendingDetail();
    const reason = "Source prompt, digest and notification preferences remain evidence; collection or delivery is not configured.";
    detail.datasets["moneyTracker.native"] = { planning: { preferences: { paymentPrompts: false, digestProtocol: { secretField: "raw-nested-value" } } }, bills: { preferences: { reminders: true, weekly: true } } };
    detail.item.pendingDomains = [
      { dataset: "moneyTracker.native.planning.preferences", path: ["moneyTracker.native", "planning", "preferences"], status: "review_required", reason, count: 1 },
      { dataset: "moneyTracker.native.notificationPreferences", path: ["moneyTracker.native", "bills"], status: "review_required", reason, count: 2 },
    ];
    const markup = renderToStaticMarkup(createElement(PendingImportDetails, { detail, onDownload: () => undefined }));
    const list = renderToStaticMarkup(createElement(PendingDomainList, { domains: detail.item.pendingDomains }));
    for (const text of ["Payment reminders", "Off in the original app", "Bill reminders", "Weekly spending summary", "On in the original app", "no reminders have been turned on"]) expect(markup).toContain(text);
    for (const technical of ["paymentPrompts", "digestProtocol", "secretField", "raw-nested-value", "evidence", "collection or delivery", "Source prompt"]) { expect(markup).not.toContain(technical); expect(list).not.toContain(technical); }
    expect(list).toContain("These reminder choices don’t have a matching feature in Alfred yet");
    expect((detail.datasets["moneyTracker.native"] as { planning: { preferences: { digestProtocol: unknown } } }).planning.preferences.digestProtocol).toEqual({ secretField: "raw-nested-value" });
    const nested = describePendingRecords("moneyTracker.native.planning.plans", [{ repeat: { internalOption: true } }], detail);
    expect(nested.records[0].fields.find((field) => field.label === "Repeat plan")?.value).toBe("Included in your download. Not scheduled in Alfred.");
  });
  it("counts only actual portfolios and never renders wrapper metadata as saved records", () => {
    const detail = syntheticPendingDetail();
    const wrapper = { contributionsLinked: true, currenciesCombined: false, portfolios: [] as unknown[], schemaVersion: 1 };
    detail.datasets["moneyTracker.portfolios"] = wrapper;
    detail.item.pendingDomains = [{ dataset: "moneyTracker.portfolios", path: ["moneyTracker.portfolios"], status: "source_evidence", reason: "Your original portfolio records stay saved.", count: 4 }];
    expect(describePendingRecords("moneyTracker.portfolios", wrapper, detail)).toEqual({ kind: "No portfolio holdings in this download", total: 0, records: [] });
    const markup = renderToStaticMarkup(createElement(PendingImportDetails, { detail, onDownload: () => undefined }));
    const list = renderToStaticMarkup(createElement(PendingDomainList, { domains: detail.item.pendingDomains }));
    expect(markup).toContain("No portfolio holdings in this download"); expect(markup).toContain("0 saved records");
    for (const metadata of ["4 saved records", "Currencies combined", "Contributions linked", "Schema version", "schemaVersion", "Saved record 1"]) { expect(markup).not.toContain(metadata); expect(list).not.toContain(metadata); }
    wrapper.portfolios.push({ id: "raw-portfolio-id", name: "Fictional shares", currency: "USD", provider: { name: "Fictional broker" }, reportedValue: 12345, marketAsOf: "2026-11-01", holdings: [{ symbol: "EXAMPLE", quantity: "3" }] });
    const populated = describePendingRecords("moneyTracker.portfolios", wrapper, detail);
    expect(populated.total).toBe(1); expect(populated.records).toHaveLength(1); expect(populated.records[0].title).toBe("Fictional shares");
    expect(populated.records[0].fields).toContainEqual({ label: "Reported value", value: "USD 123.45" });
    expect(detail.datasets["moneyTracker.portfolios"]).toBe(wrapper);
  });
  it("displays source/time/receipt/domain, saved versus active counts, and meaningful pending records", () => {
    const detail = syntheticPendingDetail(), download = vi.fn();
    const markup = renderToStaticMarkup(createElement(PendingImportDetails, { detail, onDownload: download }));
    for (const text of ["Money Tracker", "2 Nov 2026", "6 money records added", "4 other records added", "Awaiting support", "Needs review", "1 saved record", "Linked payments", "GHS 5000.00", "fictional market merchant", "Download full data"]) expect(markup).toContain(text);
    for (const technical of [detail.item.receiptId, detail.item.archiveId, String(detail.manifest.namespace), "synthetic-in-fingerprint", "synthetic-shared-group", "synthetic-funds-in", "moneyTracker.native", "JSON", "Source ID", "<pre", "schema", "fingerprint"]) expect(markup).not.toContain(technical);
    expect(download).not.toHaveBeenCalled(); expect(markup).not.toContain("Confirm activation");
  });
  it("escapes all untrusted labels and JSON, preserving exact financial values in complete raw data", () => {
    const detail = syntheticPendingDetail();
    const native = detail.datasets["moneyTracker.native"] as { planning: { thirdPartyGroups: {label:string}[] } };
    native.planning.thirdPartyGroups[0].label = "<img src=x onerror=alert(1)>";
    const markup = renderToStaticMarkup(createElement(PendingImportDetails, { detail, onDownload: () => undefined }));
    expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;"); expect(markup).not.toContain("<img src=x");
    const raw = { note: "</pre><script>alert('unsafe')</script>", principalMinor: 12500, fractionalText: "0.000001", lastRecord: { stableId: "source-last" } };
    const rawMarkup = renderToStaticMarkup(createElement(PendingRawJson, { value: raw }));
    expect(rawMarkup).not.toContain("<script>"); expect(rawMarkup).toContain("&lt;script&gt;"); expect(rawMarkup).toContain("12500"); expect(rawMarkup).toContain("0.000001"); expect(rawMarkup).toContain("source-last");
  });
  it("bounds readable previews without truncating recoverable raw records", () => {
    const detail = syntheticPendingDetail();
    const values = Array.from({ length: 21 }, (_, index) => ({ id: `rule-${index}`, account: "synthetic", description: `merchant-${index}`, direction: "out", category: "Food", active: false }));
    const readable = describePendingRecords("moneyTracker.native.planning.rules", values, detail);
    expect(readable.records).toHaveLength(20); expect(readable.total).toBe(21);
    expect(readable.records.some((record) => record.title === "merchant-20")).toBe(false);
    const raw = renderToStaticMarkup(createElement(PendingRawJson, { value: values })); expect(raw).toContain("merchant-20");
    (detail.datasets["moneyTracker.native"] as {planning:{rules:unknown[]}}).planning.rules = values;
    const markup = renderToStaticMarkup(createElement(PendingImportDetails, { detail, onDownload: () => undefined })); expect(markup).toContain("Showing the first 20 of 21 records");
  });
  it("separates source evidence and redactions from pending functionality, and exposes generic source fields safely", () => {
    const detail = syntheticPendingDetail();
    detail.item.pendingDomains = [{ dataset: "future.native", path: ["future.native"], status: "source_evidence", reason: "A complete source audit record remains recoverable.", count: 1 }];
    detail.datasets["future.native"] = [{ id: "saved-audit", accountId: "synthetic-account", note: "Fictional exact note", amountMinor: 12345, nested: { history: [1, 2] } }];
    detail.redactions = ["Structured source owner identifiers and credentials were excluded."];
    const markup = renderToStaticMarkup(createElement(PendingImportDetails, { detail, onDownload: () => undefined, busy: true }));
    expect(markup).toContain("Original records"); expect(markup).toContain("Fictional exact note"); expect(markup).toContain("GHS 123.45"); expect(markup).not.toContain("synthetic-account"); expect(markup).not.toContain("saved-audit"); expect(markup).toContain("Passwords, connections and private app information are excluded"); expect(markup).toContain("disabled"); expect(markup).not.toContain("Awaiting support");
    expect(markup).not.toContain("Linked payments");
    const account = (detail.datasets.accounts as { id: string; label: string }[])[0];
    const readable = describePendingRecords("future.native", [{ accountId: account.id, transactionId: "unresolved-raw-id" }], detail);
    expect(readable.records[0].relationships).toEqual([{ label: "Linked account", sourceId: account.id, description: account.label }]);
  });
});
