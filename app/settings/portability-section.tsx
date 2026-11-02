"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";

import { plainImportMessage, specificImportWarnings } from "@/app/settings/portability-copy";

import { Spinner } from "@/app/components/status";
import { Button, Card, ConfirmDialog, Field, inputClass } from "@/app/components/ui";
import { DatasetCoverageList, NativeFeatureSummary, nativeSummaryBlocksImport, type DatasetCoverage, type NativeImportSummary } from "@/app/settings/native-import-summary";
import { BrowserPreferenceReceiptView, BrowserPreferenceReview } from "@/app/settings/browser-preference-summary";
import type { BrowserPreferencePlan, BrowserPreferenceReceipt } from "@/lib/portability/browser-preferences";
import { availableBrowserPreferenceExportQuery, withBrowserPreferences } from "@/lib/portability/browser-preferences-client";
import { AwaitingSupportSection } from "@/app/settings/awaiting-support-section";
import type { PendingActivationPreview, PendingImportDetail, PendingImportItem, PendingImportTransport } from "@/app/settings/pending-import-types";

export type ImportCounts = Record<string, number>;
export type ImportPreview = {
  id: string;
  activationOf?: string;
  archiveId: string;
  sourceApp: string;
  exportedAt: string;
  expiresAt: string;
  counts: ImportCounts;
  additions?: ImportCounts;
  native?: NativeImportSummary;
  browserPreferences?: BrowserPreferencePlan;
  duplicates: number;
  conflicts: string[];
  unsupported: string[];
  warnings: string[];
  canConfirm: boolean;
  coverage: DatasetCoverage[];
};
export type ImportReceipt = {
  id: string;
  activationOf?: string;
  archiveId: string;
  importedAt: string;
  counts: ImportCounts;
  native?: NativeImportSummary;
  browserPreferences?: BrowserPreferenceReceipt;
  investmentNotificationsPaused?: boolean;
  unsupported: string[];
  undoAvailable: boolean;
  undoneAt?: string;
};
export type PortabilityTransport = PendingImportTransport & {
  exportArchive: () => Promise<Blob>;
  preview: (file: File) => Promise<ImportPreview>;
  confirm: (previewId: string) => Promise<ImportReceipt>;
  undo: (receiptId: string) => Promise<{ id: string; undoneAt: string; undoAvailable: false; browserPreferences?: BrowserPreferenceReceipt }>;
  receipts: () => Promise<ImportReceipt[]>;
  resumeNotifications: (receiptId: string) => Promise<{ resumed: number; receipt?: ImportReceipt }>;
};

async function responseJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as { ok?: boolean; text?: string };
  if (!response.ok || payload.ok === false) throw new Error(payload.text || "Alfred could not complete that request. Try again.");
  return payload as T;
}

const baseBrowserTransport: PortabilityTransport = {
  async exportArchive() {
    const query = availableBrowserPreferenceExportQuery();
    const response = await fetch(`/api/portability/export${query ? `?${query}` : ""}`, { cache: "no-store" });
    if (!response.ok) await responseJson(response);
    return response.blob();
  },
  async preview(file) {
    const response = await fetch("/api/portability/preview", {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: file,
    });
    return (await responseJson<{ preview: ImportPreview }>(response)).preview;
  },
  async confirm(previewId) {
    const response = await fetch("/api/portability/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ previewId }),
    });
    return (await responseJson<{ receipt: ImportReceipt }>(response)).receipt;
  },
  async undo(receiptId) {
    const response = await fetch("/api/portability/undo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ receiptId }),
    });
    return (await responseJson<{ receipt: { id: string; undoneAt: string; undoAvailable: false } }>(response)).receipt;
  },
  async receipts() {
    const response = await fetch("/api/portability/receipts", { cache: "no-store" });
    return (await responseJson<{ receipts: ImportReceipt[] }>(response)).receipts;
  },
  async resumeNotifications(receiptId) {
    const response = await fetch("/api/portability/resume-notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ receiptId }),
    });
    return responseJson<{ resumed: number; receipt?: ImportReceipt }>(response);
  },
  async pending() {
    const response = await fetch("/api/portability/pending", { cache: "no-store" });
    return (await responseJson<{ items: PendingImportItem[] }>(response)).items;
  },
  async pendingPage(cursor) {
    const response = await fetch(`/api/portability/pending${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { cache: "no-store" });
    return responseJson<{ items: PendingImportItem[]; nextCursor: string | null }>(response);
  },
  async pendingDetail(receiptId) {
    const response = await fetch(`/api/portability/pending/${encodeURIComponent(receiptId)}`, { cache: "no-store" });
    return responseJson<PendingImportDetail>(response);
  },
  async downloadPending(receiptId) {
    const response = await fetch(`/api/portability/pending/${encodeURIComponent(receiptId)}/download`, { cache: "no-store" });
    if (!response.ok) await responseJson(response);
    return response.blob();
  },
  async previewActivation(receiptId) {
    const response = await fetch(`/api/portability/pending/${encodeURIComponent(receiptId)}/preview-activation`, { method: "POST" });
    return responseJson<PendingActivationPreview>(response);
  },
};

const browserTransport: PortabilityTransport = { ...baseBrowserTransport, ...withBrowserPreferences(baseBrowserTransport) };

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const countLabels: Record<string, string> = {
  accounts: "Accounts",
  movements: "Transactions",
  snapshots: "Balances",
  transfers: "Transfers",
  settlements: "Refunds and loans",
};

function Counts({ counts }: { counts: ImportCounts }) {
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {Object.entries(counts).filter(([, count]) => count > 0).map(([domain, count]) => (
        <div key={domain} className="rounded-xl border border-line bg-bg p-3">
          <dt className="text-xs text-muted">{countLabels[domain] || "Other records"}</dt>
          <dd className="mt-1 text-lg font-medium tabular-nums">{count.toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

function Notes({ title, items, danger = false }: { title: string; items: string[]; danger?: boolean }) {
  if (!items.length) return null;
  return (
    <div className={`rounded-xl border p-3 text-sm ${danger ? "border-danger/40 text-danger" : "border-line text-muted"}`}>
      <h4 className="font-medium">{title}</h4>
      <ul className="mt-2 list-disc space-y-1 pl-5 leading-6">{items.map((text, index) => <li key={`${index}-${text}`}>{plainImportMessage(text)}</li>)}</ul>
    </div>
  );
}

/** The optional transport is used only by the development-only synthetic preview. */
export function PortabilitySection({ transport = browserTransport, sampleFile, showTitle = true, onViewData }: { transport?: PortabilityTransport; sampleFile?: File; showTitle?: boolean; onViewData?: () => void }) {
  const [busy, setBusy] = useState<"export" | "preview" | "confirm" | "undo" | "resume" | "pending" | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [receipt, setReceipt] = useState<ImportReceipt | null>(null);
  const [recentReceipts, setRecentReceipts] = useState<ImportReceipt[]>([]);
  const [receiptsError, setReceiptsError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [confirmResume, setConfirmResume] = useState(false);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const receiptHeading = useRef<HTMLHeadingElement>(null);
  const feedbackError = useRef<HTMLParagraphElement>(null);
  const canConfirm = preview?.canConfirm && preview.conflicts.length === 0 && !nativeSummaryBlocksImport(preview.native) && preview.browserPreferences?.status !== "blocked" && !preview.browserPreferences?.conflicts.length;

  useEffect(() => {
    let active = true;
    void transport.receipts().then((receipts) => { if (active) { setRecentReceipts(receipts); setReceiptsError(""); } }).catch(() => {
      if (active) setReceiptsError("Previous imports could not be loaded. Reload this page to try again.");
    });
    return () => { active = false; };
  }, [transport]);

  useEffect(() => {
    if (preview) previewHeading.current?.focus();
  }, [preview]);
  useEffect(() => {
    if (receipt) receiptHeading.current?.focus();
  }, [receipt]);
  useEffect(() => { if (error) feedbackError.current?.focus(); }, [error]);

  function selectFile(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null);
    setPreview(null);
    setError("");
    setNotice("");
  }

  async function exportArchive() {
    setBusy("export");
    setError("");
    setNotice("");
    try {
      download(await transport.exportArchive(), `alfred-finance-${new Date().toISOString().slice(0, 10)}.zip`);
      setNotice("Your download is ready. Keep it somewhere private.");
    } catch (cause) {
      setError(cause instanceof Error ? plainImportMessage(cause.message) : "The archive could not be downloaded.");
    } finally {
      setBusy(null);
    }
  }

  async function previewArchive() {
    if (!file || busy) return;
    setBusy("preview");
    setPreview(null);
    setError("");
    setNotice("");
    try {
      if (!file.name.toLowerCase().endsWith(".zip")) throw new Error("Choose a finance ZIP file.");
      if (file.size > 20_000_000) throw new Error("That ZIP is larger than the 20 MB limit. Choose a smaller finance archive.");
      setPreview(await transport.preview(file));
    } catch (cause) {
      setError(cause instanceof Error ? plainImportMessage(cause.message) : "The archive could not be checked.");
    } finally {
      setBusy(null);
    }
  }

  async function confirmImport() {
    if (!preview || !canConfirm || busy) return;
    setBusy("confirm");
    setError("");
    setNotice("");
    try {
      const imported = { ...await transport.confirm(preview.id), ...(preview.activationOf ? { activationOf: preview.activationOf } : {}) };
      setReceipt(imported);
      setRecentReceipts((current) => [imported, ...current.filter((item) => item.id !== imported.id)].slice(0, 20));
      setPreview(null);
      setNotice("");
    } catch (cause) {
      // A failed confirmation may be a stale preview. Require another review before retrying.
      setPreview(null);
      setError(cause instanceof Error ? plainImportMessage(cause.message) : "The import could not be completed. Review the file again before retrying.");
    } finally {
      setBusy(null);
    }
  }

  async function undoImport() {
    if (!receipt?.undoAvailable || receipt.browserPreferences?.undoBlocked || busy) return;
    setBusy("undo");
    setError("");
    setNotice("");
    try {
      const undone = await transport.undo(receipt.id);
      setReceipt({ ...receipt, ...undone });
      setRecentReceipts((current) => current.map((item) => item.id === receipt.id ? { ...item, ...undone } : item));
      setNotice("Import undone. Records and links from that import were removed.");
    } catch (cause) {
      setError(cause instanceof Error ? plainImportMessage(cause.message) : "The import could not be undone.");
    } finally {
      setBusy(null);
      setConfirmUndo(false);
    }
  }

  async function resumeNotifications() {
    if (!receipt?.investmentNotificationsPaused || receipt.undoneAt || busy) return;
    setBusy("resume");
    setError("");
    setNotice("");
    try {
      const result = await transport.resumeNotifications(receipt.id);
      const updated = { ...receipt, ...result.receipt, investmentNotificationsPaused: false, undoAvailable: false };
      setReceipt(updated);
      setRecentReceipts((current) => current.map((item) => item.id === receipt.id ? updated : item));
      setNotice(`Investment notices resumed for ${result.resumed.toLocaleString()} imported investment${result.resumed === 1 ? "" : "s"}. Future maturity messages can use your existing Telegram connection.`);
    } catch (cause) {
      setError(cause instanceof Error ? plainImportMessage(cause.message) : "Investment notices could not be resumed.");
    } finally {
      setBusy(null);
      setConfirmResume(false);
    }
  }

  const stage = preview ? "review" : receipt ? "success" : "choose";
  const startAgain = () => { setPreview(null); setReceipt(null); setFile(null); setError(""); setNotice(""); };
  const progress = busy === "preview" ? "Checking your file…" : busy === "confirm" ? "Importing your data…" : busy === "undo" ? "Checking and undoing this import…" : busy === "export" ? "Preparing your download…" : busy === "resume" ? "Resuming investment reminders…" : notice;

  return (
    <Card title={showTitle ? "Your data" : undefined}>
      <div className="space-y-6">
        {stage === "choose" ? <>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-5">
            <div><h3 className="font-medium">Download my data</h3><p className="mt-1 text-sm leading-6 text-muted">Your financial records and settings. Keep the download private.</p></div>
            <Button onClick={() => void exportArchive()} disabled={busy !== null} aria-busy={busy === "export"}>{busy === "export" ? <Spinner /> : null}Download my data</Button>
          </div>
          <section aria-labelledby="import-data-title" className="space-y-4">
            <h3 id="import-data-title" className="font-medium">Import data</h3>
            <Field label="Choose a ZIP file"><input key={receipt ? "receipt" : "choose"} type="file" accept=".zip,application/zip" onChange={selectFile} disabled={busy !== null} className={`${inputClass} h-auto py-3 file:mr-3 file:min-h-11 file:rounded-xl file:border-0 file:bg-surface-2 file:px-3 file:py-2 file:text-sm file:font-medium file:leading-5 file:text-ink`} /></Field>
            {sampleFile ? <Button onClick={() => { setFile(sampleFile); setPreview(null); setError(""); setNotice(""); }} disabled={busy !== null}>Use sample file</Button> : null}
            {file ? <p className="break-words text-sm text-muted" role="status">{file.name}</p> : null}
            <p className="text-xs text-faint">ZIP files up to 20 MB.</p>
            <Button variant="primary" className="w-full sm:w-auto" onClick={() => void previewArchive()} disabled={!file || busy !== null} aria-busy={busy === "preview"}>{busy === "preview" ? <Spinner /> : null}Review import</Button>
          </section>
        </> : null}

        {progress ? <p role="status" aria-live="polite" className="text-sm text-muted">{progress}</p> : null}
        {error ? <p ref={feedbackError} tabIndex={-1} role="alert" className="break-words rounded-xl border border-danger/40 p-3 text-sm leading-6 text-danger focus:outline-none">{error}</p> : null}

        {preview ? <section aria-labelledby="import-preview-title" className="space-y-5">
          <div><h3 id="import-preview-title" ref={previewHeading} tabIndex={-1} className="text-lg font-medium focus:outline-none">{preview.activationOf ? "Review saved data" : "Review your import"}</h3><p className="mt-1 text-sm text-muted">{preview.sourceApp === "money-tracker" ? "Money Tracker" : preview.sourceApp === "alfred" ? "Alfred" : "Your file"} · {new Date(preview.exportedAt).toLocaleDateString()}</p></div>
          <Counts counts={preview.counts} />
          {preview.additions && Object.values(preview.additions).some((count) => count > 0) ? <div className="space-y-2"><h4 className="text-sm font-medium">New records to add</h4><Counts counts={preview.additions} /></div> : null}
          {preview.duplicates > 0 ? <p className="text-sm text-muted">{preview.duplicates.toLocaleString()} existing record{preview.duplicates === 1 ? "" : "s"} will be skipped.</p> : null}
          {preview.native ? <NativeFeatureSummary summary={preview.native} /> : null}
          {preview.browserPreferences ? <BrowserPreferenceReview plan={preview.browserPreferences} /> : null}
          <Notes title="Needs attention" items={preview.conflicts} danger />
          {preview.unsupported.length ? <p className="rounded-xl border border-line p-3 text-sm leading-6 text-muted">Some data can’t be used in Alfred yet. It will be saved so you can view or download it.</p> : null}
          <Notes title="Before you import" items={specificImportWarnings(preview.warnings)} />
          {preview.coverage.some((item) => item.status !== "supported") ? <details className="text-sm"><summary className="cursor-pointer font-medium">What can be imported?</summary><div className="mt-3"><DatasetCoverageList coverage={preview.coverage} /></div></details> : null}
          <p className="text-xs leading-5 text-muted">Existing data won’t be overwritten. Importing does not connect bank messages or turn on reminders.</p>
          {canConfirm ? <div className="flex flex-wrap gap-3"><Button variant="primary" className="w-full sm:w-auto" onClick={() => void confirmImport()} disabled={busy !== null} aria-busy={busy === "confirm"}>{busy === "confirm" ? <Spinner /> : null}Confirm import</Button><Button variant="ghost" onClick={() => { setPreview(null); setError(""); }} disabled={busy !== null}>Back</Button></div> : <><p className="text-sm text-danger">Nothing has been imported. Resolve the issues above and review the file again.</p><Button onClick={() => setPreview(null)} disabled={busy !== null}>Choose another file</Button></>}
        </section> : null}

        {receipt && !preview ? <section aria-labelledby="import-receipt-title" className="space-y-5">
          <div><h3 id="import-receipt-title" ref={receiptHeading} tabIndex={-1} className="text-lg font-medium focus:outline-none">{receipt.undoneAt ? "Import undone" : "Your data is ready"}</h3><p className="mt-1 text-sm text-muted">{receipt.undoneAt ? "The records added by this import were removed." : `Imported ${new Date(receipt.importedAt).toLocaleDateString()}.`}</p></div>
          {Object.values(receipt.counts).some((count) => count > 0) ? <Counts counts={receipt.counts} /> : !receipt.undoneAt ? <p className="text-sm text-muted">No new accounts or transactions were added.</p> : null}
          {receipt.native ? <NativeFeatureSummary summary={receipt.native} phase="receipt" /> : null}
          {receipt.browserPreferences ? <BrowserPreferenceReceiptView receipt={receipt.browserPreferences} undone={!!receipt.undoneAt} /> : null}
          {receipt.unsupported.length && !receipt.undoneAt ? <p className="rounded-xl border border-line p-3 text-sm leading-6 text-muted">Some data is saved for later support. You can view or download it below.</p> : null}
          {receipt.investmentNotificationsPaused && !receipt.undoneAt ? <div className="space-y-2 text-sm leading-6"><p className="text-muted">Investment reminders are paused. Resuming them may send future messages and prevents undoing this import.</p><Button size="sm" onClick={() => setConfirmResume(true)} disabled={busy !== null}>Resume investment reminders</Button></div> : null}
          <div className="flex flex-wrap gap-3">{onViewData && !receipt.undoneAt ? <Button variant="primary" className="w-full sm:w-auto" onClick={onViewData}>View my data</Button> : null}<Button variant={onViewData && !receipt.undoneAt ? "ghost" : "primary"} onClick={startAgain} disabled={busy !== null}>Done</Button></div>
          {receipt.undoAvailable && !receipt.browserPreferences?.undoBlocked ? <details className="border-t border-line pt-4 text-sm"><summary className="cursor-pointer text-muted">Undo this import</summary><p className="my-3 text-xs leading-5 text-muted">Undo is available only if your records haven’t changed since the import. Later edits are kept safe.</p><Button size="sm" onClick={() => setConfirmUndo(true)} disabled={busy !== null}>Undo import</Button></details> : null}
        </section> : null}

        {!preview ? <details className="border-t border-line pt-4"><summary className="cursor-pointer text-sm font-medium">Previous imports</summary><div className="mt-3 space-y-4">{recentReceipts.length ? <ul className="divide-y divide-line text-sm">{recentReceipts.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-3"><span className="text-muted">{new Date(item.importedAt).toLocaleString()}{item.undoneAt ? " · Undone" : ""}</span><Button size="sm" onClick={() => { setReceipt(item); setError(""); setNotice(""); }} disabled={busy !== null}>View import</Button></li>)}</ul> : <p className="text-sm text-muted">No previous imports.</p>}{receiptsError ? <p className="text-xs text-muted">{receiptsError}</p> : null}</div></details> : null}
        {!preview ? <AwaitingSupportSection transport={transport} refreshKey={`${receipt?.id ?? ""}:${receipt?.undoneAt ?? ""}`} highlightedReceiptId={receipt?.activationOf ?? receipt?.id} busy={busy !== null} onBusyChange={(active) => setBusy(active ? "pending" : null)} onReviewStart={() => { setPreview(null); setError(""); setNotice(""); }} onActivationPreview={(next) => { setPreview(next); setError(""); setNotice(""); }} /> : null}
        {stage === "choose" ? <p className="text-xs leading-5 text-faint">Passwords and account connections are excluded. No AI is used.</p> : null}
      </div>
      <ConfirmDialog
        open={confirmUndo}
        title="Undo this import?"
        body="This removes the records added by this import. If you changed your data afterward, undo is blocked to keep those changes safe."
        confirmLabel="Undo import"
        busy={busy === "undo"}
        onConfirm={() => void undoImport()}
        onClose={() => busy ? undefined : setConfirmUndo(false)}
      />
      <ConfirmDialog
        open={confirmResume}
        title="Resume investment reminders?"
        body="Future investment reminders may be sent through your existing Telegram connection. You won’t be able to undo this import afterward."
        confirmLabel="Resume reminders"
        busy={busy === "resume"}
        onConfirm={() => void resumeNotifications()}
        onClose={() => busy ? undefined : setConfirmResume(false)}
      />
    </Card>
  );
}
