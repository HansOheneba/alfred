"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Card, ConfirmDialog } from "@/app/components/ui";
import { Spinner } from "@/app/components/status";

type DeviceHealth = {
  deviceId: string;
  state: "ready" | "needs_review" | "capture_error";
  counts: { sourceQuarantine: number; unreadable: number; incomplete: number; heldForReview: number; pending: number };
  lastSeenAt: string;
  lastSuccessfulCaptureAt: string | null;
  lastAcceptedAt: string | null;
};
export type CollectorHealthData = { ownerId: string; checkedAt: string; devices: DeviceHealth[] };
const unavailable = "Mac status could not be checked. Try again.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validTime = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

/** Keep operational counts only; accidental private server fields never reach UI. */
export function parseCollectorHealth(value: unknown, expectedOwner?: string): CollectorHealthData {
  const result = value as Record<string, unknown> | null;
  if (!result || result.ok !== true || typeof result.ownerId !== "string" || !UUID.test(result.ownerId) || !validTime(result.checkedAt) || !Array.isArray(result.devices) || result.devices.length > 10) throw new Error(unavailable);
  if (expectedOwner && result.ownerId !== expectedOwner) throw new Error("Your session changed. Reload this page to continue.");
  const checked = Date.parse(result.checkedAt);
  const devices = result.devices.map((value): DeviceHealth => {
    const item = value as Record<string, unknown> | null;
    const counts = item?.counts as Record<string, unknown> | null;
    if (!item || typeof item.deviceId !== "string" || !UUID.test(item.deviceId) || !["ready", "needs_review", "capture_error"].includes(String(item.state)) || !counts || !validTime(item.lastSeenAt) || Date.parse(item.lastSeenAt) > checked + 5 * 60_000) throw new Error(unavailable);
    const safeCounts = {} as DeviceHealth["counts"];
    for (const key of ["sourceQuarantine", "unreadable", "incomplete", "heldForReview", "pending"] as const) {
      const count = counts[key];
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > 1_000_000) throw new Error(unavailable);
      safeCounts[key] = count;
    }
    for (const key of ["lastSuccessfulCaptureAt", "lastAcceptedAt"] as const) if (item[key] !== null && (!validTime(item[key]) || Date.parse(item[key]) > checked + 5 * 60_000)) throw new Error(unavailable);
    if (safeCounts.unreadable + safeCounts.incomplete > safeCounts.sourceQuarantine || safeCounts.heldForReview > safeCounts.pending || (item.state === "ready" && (Object.values(safeCounts).some(count => count > 0) || item.lastSuccessfulCaptureAt === null))) throw new Error(unavailable);
    return { deviceId: item.deviceId, state: item.state as DeviceHealth["state"], counts: safeCounts, lastSeenAt: item.lastSeenAt, lastSuccessfulCaptureAt: item.lastSuccessfulCaptureAt as string | null, lastAcceptedAt: item.lastAcceptedAt as string | null };
  });
  if (new Set(devices.map(device => device.deviceId)).size !== devices.length) throw new Error(unavailable);
  return { ownerId: result.ownerId, checkedAt: result.checkedAt, devices };
}

export async function readCollectorHealth(ownerId?: string, signal?: AbortSignal): Promise<CollectorHealthData> {
  const response = await fetch("/api/collector/health", { credentials: "same-origin", cache: "no-store", signal });
  if (!response.ok) throw new Error(unavailable);
  return parseCollectorHealth(await response.json().catch(() => null), ownerId);
}

/** Confirm the exact owner/device response before changing the displayed list. */
export async function removeSavedCollectorStatus(ownerId: string, deviceId: string, signal?: AbortSignal): Promise<boolean> {
  const failure = "The saved Mac status could not be removed. Try again.";
  if (!UUID.test(ownerId) || !UUID.test(deviceId)) throw new Error(failure);
  const response = await fetch("/api/collector/health/devices", {
    method: "DELETE", credentials: "same-origin", cache: "no-store", signal,
    headers: { "content-type": "application/json", "x-alfred-owner": ownerId },
    body: JSON.stringify({ deviceId }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result || result.ok !== true || result.ownerId !== ownerId || result.deviceId !== deviceId || typeof result.removed !== "boolean") throw new Error(failure);
  return result.removed;
}

function when(value: string) { return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(value)); }
type RemovalSelection = { ownerId: string; deviceId: string; label: string; lastSeenAt: string };

export function CollectorHealthSection({ ownerId, preview = false, initial }: { ownerId?: string; preview?: boolean; initial?: CollectorHealthData }) {
  const [data, setData] = useState<CollectorHealthData | null>(initial ?? null);
  const [loading, setLoading] = useState(!preview && !initial);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [selection, setSelection] = useState<RemovalSelection | null>(null);
  const [removing, setRemoving] = useState(false);
  const [notice, setNotice] = useState<{ ownerId: string; text: string; error?: boolean } | null>(null);
  const requestVersion = useRef(0);
  const removalController = useRef<AbortController | null>(null);
  const activeOwner = useRef(ownerId ?? initial?.ownerId);
  const visibleData = data && (!ownerId || data.ownerId === ownerId) ? data : null;
  useEffect(() => {
    const version = ++requestVersion.current;
    activeOwner.current = ownerId ?? (preview ? initial?.ownerId : undefined);
    const resetRemoval = () => { removalController.current?.abort(); removalController.current = null; };
    resetRemoval();
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      setSelection(null); setNotice(null); setRemoving(false);
      if (preview) return;
      setLoading(true); setError(""); setData(null);
      try { const next = await readCollectorHealth(ownerId, controller.signal); if (!controller.signal.aborted && version === requestVersion.current) { activeOwner.current = next.ownerId; setData(next); } }
      catch { if (!controller.signal.aborted && version === requestVersion.current) setError(unavailable); }
      finally { if (!controller.signal.aborted && version === requestVersion.current) setLoading(false); }
    });
    return () => { controller.abort(); resetRemoval(); activeOwner.current = undefined; };
  }, [ownerId, preview, attempt, initial?.ownerId]);

  async function removeSelectedStatus() {
    const target = selection;
    if (!target || removing || !visibleData || target.ownerId !== visibleData.ownerId || activeOwner.current !== target.ownerId || !visibleData.devices.some(device => device.deviceId === target.deviceId)) return;
    if (removalController.current && !removalController.current.signal.aborted) return;
    const version = ++requestVersion.current;
    const controller = new AbortController();
    removalController.current?.abort(); removalController.current = controller;
    setRemoving(true); setNotice(null);
    try {
      if (!preview) await removeSavedCollectorStatus(target.ownerId, target.deviceId, controller.signal);
      if (controller.signal.aborted || version !== requestVersion.current) return;
      setData(previous => previous?.ownerId === target.ownerId ? { ...previous, devices: previous.devices.filter(device => device.deviceId !== target.deviceId) } : previous);
      setSelection(null);
      setNotice({ ownerId: target.ownerId, text: preview ? "Sample status removed for this visit. No Mac was disconnected and no account data was changed." : "Saved status removed. Collection and saved alerts are unchanged. This Mac may appear again when it checks in." });
    } catch {
      if (!controller.signal.aborted && version === requestVersion.current) setNotice({ ownerId: target.ownerId, text: "The saved Mac status could not be removed. Try again.", error: true });
    } finally {
      if (!controller.signal.aborted && version === requestVersion.current) { setRemoving(false); removalController.current = null; }
    }
  }
  return <Card title="Your Mac’s check-ins">
    <p className="text-sm leading-6 text-muted">A check-in tells you what the collector last reported. It does not prove a payment arrived or that money cleared.</p>
    {notice && !selection && visibleData?.ownerId === notice.ownerId ? <p className={`mt-4 text-sm ${notice.error ? "text-danger" : "text-muted"}`} role={notice.error ? "alert" : "status"}>{notice.text}</p> : null}
    {loading ? <p className="mt-4 flex items-center gap-2 text-sm text-muted" role="status"><Spinner />Checking Mac status…</p> : null}
    {error ? <div className="mt-4"><p role="alert" className="text-sm text-danger">{error}</p><Button size="sm" className="mt-3" onClick={() => setAttempt(value => value + 1)}>Try again</Button></div> : null}
    {!loading && !error && (!visibleData || !visibleData.devices.length) ? <p className="mt-4 rounded-xl bg-bg p-3 text-sm leading-6 text-muted">{preview ? "No sample Mac has checked in. Capture is still off." : "No Mac has checked in yet. A downloaded app or forwarding key alone does not confirm setup."}</p> : null}
    {visibleData?.devices.map((device, index) => {
      const stale = Date.parse(visibleData.checkedAt) - Date.parse(device.lastSeenAt) > 10 * 60_000;
      const needsReview = device.counts.sourceQuarantine + device.counts.heldForReview;
      const awaitingAcceptance = Math.max(0, device.counts.pending - device.counts.heldForReview);
      return <div key={device.deviceId} className="mt-4 rounded-xl border border-line bg-bg p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">Mac {index + 1}</h3><span className="text-xs text-muted">{stale ? "Check-in overdue" : device.state === "capture_error" ? "Needs a check" : needsReview ? "Items need review" : awaitingAcceptance ? "Alerts waiting" : device.state === "ready" ? "Check-in received" : "Needs a check"}</span></div>
        <p className="mt-2 text-xs text-muted">Last heard: {when(device.lastSeenAt)}</p>
        {stale ? <p className="mt-3 text-sm leading-6 text-muted">Alfred has not heard from this Mac recently. Check that it is awake and the collector is available.</p> : null}
        {device.state === "capture_error" ? <p className="mt-3 text-sm leading-6 text-muted">The last Messages check did not complete. Check the collector on your Mac; saved alerts stay in place.</p> : null}
        {device.counts.sourceQuarantine > 0 ? <p className="mt-3 text-sm leading-6 text-muted">{device.counts.sourceQuarantine} Messages item{device.counts.sourceQuarantine === 1 ? " needs" : "s need"} a check. They are kept for retry; later readable alerts can continue.</p> : null}
        {device.counts.heldForReview > 0 ? <p className="mt-3 text-sm leading-6 text-muted">{device.counts.heldForReview} alert{device.counts.heldForReview === 1 ? " is" : "s are"} held safely on your Mac for review. Alfred has not confirmed full processing; some records may already exist. In the collector’s inactive opening window, choose “Review saved alerts”. The Mac prototype still requires its separate setup.</p> : null}
        {awaitingAcceptance > 0 ? <p className="mt-3 text-sm leading-6 text-muted">{awaitingAcceptance} alert{awaitingAcceptance === 1 ? " is" : "s are"} waiting for Alfred’s receipt. They stay saved on your Mac while delivery retries.</p> : null}
        <dl className="mt-3 space-y-1 text-xs leading-5 text-muted"><div><dt className="inline">Last completed Messages check: </dt><dd className="inline">{device.lastSuccessfulCaptureAt ? when(device.lastSuccessfulCaptureAt) : "Not reported"}</dd></div><div><dt className="inline">Last alert accepted by Alfred: </dt><dd className="inline">{device.lastAcceptedAt ? when(device.lastAcceptedAt) : "Not reported"}</dd></div></dl>
        <Button size="sm" variant="ghost" className="mt-3" disabled={removing} onClick={() => { setNotice(null); setSelection({ ownerId: visibleData.ownerId, deviceId: device.deviceId, label: `Mac ${index + 1}`, lastSeenAt: device.lastSeenAt }); }}>Remove saved status</Button>
      </div>;
    })}
    <ConfirmDialog
      open={!!selection && selection.ownerId === visibleData?.ownerId}
      title={`Remove saved status for ${selection?.label ?? "this Mac"}?`}
      body={<><p>{selection ? `Last heard: ${when(selection.lastSeenAt)}.` : ""}</p><p className="mt-2">This removes only the saved check-in and frees a place in your Mac status list. It does not stop collection, revoke the forwarding key, delete saved alerts or change financial records. An active Mac may appear again when it checks in.</p>{preview ? <p className="mt-2">Sample only. This changes this fictional visit and makes no account request.</p> : null}{notice?.error && notice.ownerId === selection?.ownerId ? <p role="alert" className="mt-2 text-danger">{notice.text}</p> : null}</>}
      confirmLabel="Remove saved status"
      busy={removing}
      onConfirm={() => void removeSelectedStatus()}
      onClose={() => { if (!removing) setSelection(null); }}
    />
  </Card>;
}

/** Local examples only: no collector, account read or permission request. */
export function CollectorHealthPreview() {
  const [example, setExample] = useState<"none" | "review" | "stale">("none");
  const data: CollectorHealthData = {
    ownerId: "00000000-0000-4000-8000-000000000001", checkedAt: "2026-11-03T14:30:00Z",
    devices: example === "none" ? [] : [{
      deviceId: "00000000-0000-4000-8000-000000000002", state: "needs_review",
      counts: { sourceQuarantine: 2, unreadable: 1, incomplete: 1, heldForReview: 1, pending: 1 },
      lastSeenAt: example === "stale" ? "2026-11-03T12:00:00Z" : "2026-11-03T14:29:00Z",
      lastSuccessfulCaptureAt: "2026-11-03T14:28:00Z", lastAcceptedAt: null,
    }],
  };
  return <section aria-label="Fictional Mac status examples">
    <p className="mb-2 text-xs text-muted">Fictional status examples · no Mac is connected</p>
    <div className="mb-3 grid grid-cols-3 gap-1 rounded-xl border border-line bg-bg p-1" role="group" aria-label="Sample Mac status">
      {([{ id: "none", label: "No Mac" }, { id: "review", label: "Needs review" }, { id: "stale", label: "Old check-in" }] as const).map(item => <button key={item.id} type="button" aria-pressed={example === item.id} onClick={() => setExample(item.id)} className={`min-h-11 rounded-lg px-2 text-xs font-medium focus-visible:outline-2 focus-visible:outline-accent ${example === item.id ? "bg-surface-2 text-ink" : "text-muted"}`}>{item.label}</button>)}
    </div>
    <CollectorHealthSection key={example} preview initial={data} />
  </section>;
}
