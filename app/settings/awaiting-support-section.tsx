"use client";

import { useEffect, useRef, useState } from "react";

import { Spinner } from "@/app/components/status";
import { Button } from "@/app/components/ui";
import { datasetLabel } from "@/app/settings/native-import-summary";
import { PendingImportDetails, isPortfolioWrapper, pendingDomainReason } from "@/app/settings/pending-import-details";
import type { PendingImportDetail, PendingImportDomain, PendingImportItem, PendingImportTransport } from "@/app/settings/pending-import-types";
import type { ImportPreview } from "@/app/settings/portability-section";
import { plainImportMessage } from "@/app/settings/portability-copy";

const statuses: Record<PendingImportDomain["status"], string> = { awaiting_support: "Awaiting support", review_required: "Needs review", source_evidence: "Original records" };
const appLabel = (app: string) => app === "money-tracker" ? "Money Tracker" : app === "alfred" ? "Alfred" : "Finance data";
const sum = (counts: Record<string, number>) => Object.values(counts).reduce((total, count) => total + count, 0);

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function PendingDomainList({ domains }: { domains: PendingImportDomain[] }) {
  return <ul className="space-y-3 text-xs leading-5">{domains.map((domain, index) => <li key={`${domain.dataset}-${index}`}><p className="break-words font-medium text-ink">{datasetLabel(domain.dataset)} · {statuses[domain.status]}</p><p className="text-muted">{isPortfolioWrapper(domain.dataset) ? "Your complete portfolio download is saved." : domain.count === null ? "Your complete records are saved." : `${domain.count.toLocaleString()} saved ${domain.count === 1 ? "record" : "records"}.`} {pendingDomainReason(domain)}</p></li>)}</ul>;
}

export function AwaitingSupportSection({ transport, refreshKey, highlightedReceiptId, busy: parentBusy, onBusyChange, onReviewStart, onActivationPreview }: {
  transport: PendingImportTransport;
  refreshKey: string;
  highlightedReceiptId?: string;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onReviewStart: () => void;
  onActivationPreview: (preview: ImportPreview) => void;
}) {
  const [items, setItems] = useState<PendingImportItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [operation, setOperation] = useState<{ receiptId: string; kind: "details" | "download" | "activation" | "older" } | null>(null);
  const [detail, setDetail] = useState<PendingImportDetail | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflicts, setConflicts] = useState<string[]>([]);
  const detailHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let active = true;
    const page = transport.pendingPage ? transport.pendingPage() : transport.pending().then((items) => ({ items, nextCursor: null }));
    void page.then((next) => { if (active) { setItems(next.items); setNextCursor(next.nextCursor); setLoading(false); setError(""); } }).catch((cause) => {
      if (active) { setLoading(false); setError(cause instanceof Error ? cause.message : "Saved import records could not be loaded."); }
    });
    return () => { active = false; };
  }, [transport, refreshKey, refresh]);

  useEffect(() => { if (detail) detailHeading.current?.focus(); }, [detail]);

  async function run(item: PendingImportItem, kind: "details" | "download" | "activation") {
    if (operation || parentBusy) return;
    setOperation({ receiptId: item.receiptId, kind }); onBusyChange(true); setError(""); setNotice(""); setConflicts([]);
    if (kind === "activation") onReviewStart();
    try {
      if (kind === "details") setDetail(await transport.pendingDetail(item.receiptId));
      else if (kind === "download") {
        download(await transport.downloadPending(item.receiptId), `alfred-finances-${new Date(item.importedAt).toISOString().slice(0,10)}.zip`);
        setNotice("Your full finance download is ready. Keep it somewhere private.");
      } else {
        const result = await transport.previewActivation(item.receiptId);
        if (result.status === "ready") onActivationPreview({ ...result.preview, activationOf: result.preview.activationOf ?? item.receiptId });
        else {
          setNotice(plainImportMessage(result.text));
          setConflicts(result.conflicts ?? []);
          if (result.pendingDomains) setItems((current) => current.map((row) => row.receiptId === item.receiptId ? { ...row, pendingDomains: result.pendingDomains! } : row));
        }
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "That saved import could not be checked."); }
    finally { setOperation(null); onBusyChange(false); }
  }

  async function loadOlder() {
    if (!nextCursor || !transport.pendingPage || operation || parentBusy) return;
    setOperation({ receiptId: "", kind: "older" }); onBusyChange(true); setError("");
    try {
      const page = await transport.pendingPage(nextCursor);
      setItems((current) => [...new Map([...current, ...page.items].map((item) => [item.receiptId, item])).values()]);
      setNextCursor(page.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Older saved imports could not be loaded."); }
    finally { setOperation(null); onBusyChange(false); }
  }

  const disabled = parentBusy || operation !== null;
  const awaitingCount = items.reduce((count, item) => count + item.pendingDomains.filter((domain) => domain.status !== "source_evidence").length, 0);
  return (
    <section aria-labelledby="awaiting-support-title" className="space-y-4 border-t border-line pt-5">
      <details>
      <summary className="cursor-pointer text-sm font-medium focus-visible:outline-2 focus-visible:outline-accent"><span id="awaiting-support-title">Awaiting support</span>{!loading && items.length ? <span className="ml-2 text-xs font-normal text-muted">{awaitingCount ? `${awaitingCount} waiting for support or review` : `${items.length} saved imports`}</span> : null}</summary>
      <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Awaiting support</h3>
        <Button size="sm" onClick={() => { setLoading(true); setRefresh((value) => value + 1); }} disabled={disabled || loading}>Refresh</Button>
      </div>
      <p className="text-xs leading-5 text-muted">Records Alfred can’t use yet stay saved in full. View or download them here. Checking support won’t change anything; you’ll review and confirm any additions.</p>
      {loading ? <p role="status" className="text-xs text-muted">Loading saved imports…</p> : !items.length && !error ? <p className="rounded-xl border border-dashed border-line p-4 text-xs text-muted">No saved imports yet. After an import, records awaiting support appear here.</p> : null}
      <ul className="space-y-3">
        {items.map((item) => {
          const pending = item.pendingDomains.filter((domain) => domain.status !== "source_evidence");
          const evidence = item.pendingDomains.filter((domain) => domain.status === "source_evidence");
          const selected = item.receiptId === highlightedReceiptId;
          return <li key={item.receiptId} className={`space-y-3 rounded-xl border p-4 ${selected ? "border-line-strong" : "border-line"}`}>
            <div><h4 className="text-sm font-medium">{appLabel(item.sourceApp)}{item.undone ? " · Undone" : pending.length ? " · Some records need support or review" : " · Original records saved"}</h4><p className="mt-1 text-xs text-muted">{new Date(item.importedAt).toLocaleString()}</p></div>
            <dl className="grid grid-cols-2 gap-3 rounded-xl bg-bg p-3 text-xs"><div><dt className="text-muted">Money records added</dt><dd className="mt-1 font-medium tabular-nums">{sum(item.activeCounts.accounting).toLocaleString()}</dd></div><div><dt className="text-muted">Other records added</dt><dd className="mt-1 font-medium tabular-nums">{sum(item.activeCounts.native).toLocaleString()}</dd></div></dl>
            {pending.length ? <PendingDomainList domains={pending} /> : <p className="text-xs text-muted">No records in this import are currently marked as awaiting support.</p>}
            {evidence.length ? <details><summary className="cursor-pointer text-xs font-medium focus-visible:outline-2 focus-visible:outline-accent">Original records ({evidence.length})</summary><div className="mt-3"><PendingDomainList domains={evidence} /></div></details> : null}
            {item.undone ? <p className="text-xs leading-5 text-muted">This import was undone. Your original records are still available to view and download.</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void run(item, "details")} disabled={disabled} aria-busy={operation?.receiptId === item.receiptId && operation.kind === "details"}>{operation?.receiptId === item.receiptId && operation.kind === "details" ? <Spinner /> : null}View saved data</Button>
              <Button size="sm" onClick={() => void run(item, "download")} disabled={disabled}>Download full data</Button>
              {!item.undone && item.activationAvailable ? <Button size="sm" onClick={() => void run(item, "activation")} disabled={disabled} aria-busy={operation?.receiptId === item.receiptId && operation.kind === "activation"}>{operation?.receiptId === item.receiptId && operation.kind === "activation" ? <Spinner /> : null}Check what can be added</Button> : null}
            </div>
          </li>;
        })}
      </ul>
      {nextCursor ? <Button size="sm" onClick={() => void loadOlder()} disabled={disabled} aria-busy={operation?.kind === "older"}>{operation?.kind === "older" ? <Spinner /> : null}Older imports</Button> : null}
      {detail ? <section aria-labelledby="saved-import-detail-title" className="space-y-3 rounded-xl border border-line-strong p-4"><div className="flex items-center justify-between gap-3"><h4 id="saved-import-detail-title" ref={detailHeading} tabIndex={-1} className="text-sm font-medium focus:outline-none">Saved import details</h4><Button size="sm" variant="ghost" onClick={() => setDetail(null)} disabled={disabled}>Close details</Button></div><PendingImportDetails detail={detail} onDownload={() => void run(detail.item, "download")} busy={disabled} /></section> : null}
      {notice ? <p role="status" className="text-xs leading-5 text-muted">{notice}</p> : null}
      {conflicts.length ? <div className="text-xs leading-5 text-danger"><h4 className="font-medium">Some records need review</h4><ul className="mt-1 list-disc space-y-1 pl-5">{conflicts.map((conflict, index) => <li key={`${index}-${conflict}`} className="break-words">{plainImportMessage(conflict)}</li>)}</ul></div> : null}
      {error ? <p role="alert" className="text-xs leading-5 text-danger">{plainImportMessage(error)}</p> : null}
      </div>
      </details>
    </section>
  );
}
