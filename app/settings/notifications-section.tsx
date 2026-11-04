"use client";

import { useEffect, useRef, useState } from "react";

import { Button, Card } from "@/app/components/ui";
import { Spinner } from "@/app/components/status";
import type { NotificationPreferences } from "@/lib/notifications/store";

export const EMPTY_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  paymentMentions: false, outgoingMentions: false, paymentPush: false, paymentPreview: false, billReminders: false, weeklyOverview: false,
  paymentMentionsSince: null, outgoingMentionsSince: null, paymentPushSince: null, billRemindersSince: null, weeklyOverviewSince: null,
};
export type NotificationSettingsData = {
  ownerId: string;
  preferences: NotificationPreferences;
  push: { configured: boolean; publicKey: string | null; deliveryEnabled: boolean; schedulesEnabled: boolean; recoveryReady?: boolean };
  devices: { id: string; createdAt: string }[];
};
type EpochPreferenceKey = "paymentMentions" | "outgoingMentions" | "paymentPush" | "billReminders" | "weeklyOverview";
type PreferenceKey = EpochPreferenceKey | "paymentPreview";
const preferenceKeys: EpochPreferenceKey[] = ["paymentMentions", "outgoingMentions", "paymentPush", "billReminders", "weeklyOverview"];
const unavailable = "Notification settings could not be loaded. Please try again.";

/** Ignore all extra server fields, including subscription endpoints or private keys. */
export function parseNotificationSettings(value: unknown, expectedOwner?: string): NotificationSettingsData {
  const payload = value as Record<string, unknown> | null;
  const prefs = payload?.preferences as Record<string, unknown> | null;
  const push = payload?.push as Record<string, unknown> | null;
  if (payload?.ok !== true || typeof payload.ownerId !== "string" || !prefs || !push || !Array.isArray(payload.devices)) throw new Error(unavailable);
  if (expectedOwner && payload.ownerId !== expectedOwner) throw new Error("Your session changed. Reload this page to continue.");
  if (!preferenceKeys.every((key) => typeof prefs[key] === "boolean") || !["configured", "deliveryEnabled", "schedulesEnabled"].every((key) => typeof push[key] === "boolean")) throw new Error(unavailable);
  if (prefs.paymentPreview !== undefined && typeof prefs.paymentPreview !== "boolean") throw new Error(unavailable);
  if (push.recoveryReady !== undefined && typeof push.recoveryReady !== "boolean") throw new Error(unavailable);
  if (push.publicKey !== null && (typeof push.publicKey !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(push.publicKey))) throw new Error(unavailable);
  const preferences = { ...EMPTY_NOTIFICATION_PREFERENCES };
  preferences.paymentPreview = prefs.paymentPreview === true;
  for (const key of preferenceKeys) {
    preferences[key] = prefs[key] as boolean;
    const sinceKey = `${key}Since` as keyof Pick<NotificationPreferences, "paymentMentionsSince" | "outgoingMentionsSince" | "paymentPushSince" | "billRemindersSince" | "weeklyOverviewSince">;
    const since = prefs[sinceKey];
    if (since !== null && (typeof since !== "string" || !Number.isFinite(Date.parse(since)))) throw new Error(unavailable);
    preferences[sinceKey] = since as string | null;
  }
  const devices = payload.devices.map((item) => {
    const device = item as Record<string, unknown> | null;
    if (!device || typeof device.id !== "string" || !/^[0-9a-f-]{36}$/i.test(device.id) || typeof device.createdAt !== "string" || !Number.isFinite(Date.parse(device.createdAt))) throw new Error(unavailable);
    return { id: device.id, createdAt: device.createdAt };
  });
  return {
    ownerId: payload.ownerId, preferences,
    push: { configured: push.configured as boolean, publicKey: push.publicKey as string | null, deliveryEnabled: push.deliveryEnabled as boolean, schedulesEnabled: push.schedulesEnabled as boolean, recoveryReady: push.recoveryReady === true },
    devices,
  };
}

export async function readNotificationSettings(ownerId?: string, signal?: AbortSignal): Promise<NotificationSettingsData> {
  const response = await fetch("/api/notifications", { credentials: "same-origin", cache: "no-store", signal });
  if (!response.ok) throw new Error(unavailable);
  return parseNotificationSettings(await response.json().catch(() => null), ownerId);
}

function publicKeyBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const decoded = atob(base64);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
type Subscription = Pick<PushSubscription, "toJSON" | "unsubscribe"> & {
  options?: Pick<PushSubscriptionOptions, "applicationServerKey">;
};
type BrowserRegistration = { pushManager: { getSubscription(): Promise<Subscription | null>; subscribe(options: PushSubscriptionOptionsInit): Promise<Subscription> } };
export type NotificationConnectionActions = {
  requestPermission(): Promise<NotificationPermission>;
  register(): Promise<BrowserRegistration>;
  save(subscription: PushSubscriptionJSON): Promise<{ deviceId: string }>;
};

class ExistingNotificationConnection extends Error {
  constructor() {
    super("This browser needs to reconnect. Turn off its existing notification connection first, or use a separate browser profile. The existing connection was kept.");
  }
}

function usesServerKey(subscription: Subscription, publicKey: string): boolean {
  const existing = subscription.options?.applicationServerKey;
  if (!existing) return false;
  const expected = publicKeyBytes(publicKey), actual = new Uint8Array(existing);
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
}

/** The first asynchronous action is the explicit user-gesture permission request. */
export async function connectNotificationDevice(publicKey: string, actions: NotificationConnectionActions): Promise<string> {
  if (!/^[A-Za-z0-9_-]{87}$/.test(publicKey)) throw new Error("Browser notifications are not ready yet.");
  let permission: NotificationPermission;
  try { permission = await actions.requestPermission(); }
  catch { throw new Error("This browser could not request notification permission. Your account choices are unchanged."); }
  if (permission !== "granted") throw new Error(permission === "denied" ? "Notifications are blocked in this browser. You can change that in your browser settings." : "Notifications were not allowed. Your choices are unchanged.");
  let existing: Subscription | null;
  let subscription: Subscription;
  try {
    const registration = await actions.register();
    existing = await registration.pushManager.getSubscription();
    // A registration can have only one subscription. Replacing its key would
    // destroy the old connection before the new account link could be saved.
    // Require an explicit disconnect instead; unknown key metadata is not proof
    // that an existing subscription belongs to this server/account connection.
    if (existing && !usesServerKey(existing, publicKey)) throw new ExistingNotificationConnection();
    subscription = existing ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKeyBytes(publicKey) });
  } catch (error) {
    if (error instanceof ExistingNotificationConnection) throw error;
    throw new Error("This browser could not finish notification setup. Your account choices are unchanged.");
  }
  try {
    const result = await actions.save(subscription.toJSON());
    if (typeof result.deviceId !== "string" || !/^[0-9a-f-]{36}$/i.test(result.deviceId)) throw new Error("The browser could not be linked to your account.");
    return result.deviceId;
  } catch {
    if (!existing) await subscription.unsubscribe().catch(() => false);
    throw new Error("The browser link could not be confirmed. Reload to check it before trying again.");
  }
}

class NotificationRecoveryUnavailable extends Error {
  constructor(){super("Device notifications aren’t ready yet. Your chat choices still work.");}
}
async function sendNotificationJson(path: string, method: string, body: unknown, expectedOwner: string) {
  const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json", "x-alfred-owner": expectedOwner }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => null) as { ok?: boolean; deviceId?: string; ownerId?: string; preferences?: unknown; recoveryReady?: boolean } | null;
  if (!response.ok && payload?.recoveryReady === false) throw new NotificationRecoveryUnavailable();
  if (!response.ok || payload?.ok !== true || (payload.ownerId !== undefined && payload.ownerId !== expectedOwner)) throw new Error("That change couldn’t be confirmed. Reload your choices to check it.");
  return payload;
}
type DevicePushManager = BrowserRegistration["pushManager"];
function hostPushManager(): DevicePushManager | undefined {
  return (window as Window & { pushManager?: DevicePushManager }).pushManager;
}
function browserCanNotify(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && "Notification" in window &&
    (!!hostPushManager() || ("serviceWorker" in navigator && "PushManager" in window));
}
async function existingPushManager(): Promise<DevicePushManager | undefined> {
  return hostPushManager() ?? (await navigator.serviceWorker.getRegistration("/"))?.pushManager;
}
function confirmedPreferences(value: unknown): NotificationPreferences {
  const payload = value as Record<string, unknown> | null;
  if (!payload) throw new Error("The saved choices could not be confirmed. Reload to check them.");
  const preferences = { ...EMPTY_NOTIFICATION_PREFERENCES };
  if (payload.paymentPreview !== undefined && typeof payload.paymentPreview !== "boolean") throw new Error("The saved choices could not be confirmed. Reload to check them.");
  preferences.paymentPreview = payload.paymentPreview === true;
  for (const key of preferenceKeys) {
    const sinceKey = `${key}Since` as keyof Pick<NotificationPreferences, "paymentMentionsSince" | "outgoingMentionsSince" | "paymentPushSince" | "billRemindersSince" | "weeklyOverviewSince">;
    const since = payload[sinceKey];
    if (typeof payload[key] !== "boolean" || (since !== null && (typeof since !== "string" || !Number.isFinite(Date.parse(since))))) throw new Error("The saved choices could not be confirmed. Reload to check them.");
    preferences[key] = payload[key] as boolean;
    preferences[sinceKey] = since as string | null;
  }
  return preferences;
}

export function DiscreetNotificationPreview({ showAmounts = false }: { showAmounts?: boolean }) {
  return <div className="rounded-xl border border-line bg-bg p-4" aria-label="Example lock screen notification">
    <p className="text-xs font-medium text-muted">Alfred <span className="float-right font-normal text-faint">now</span></p>
    <p className="mt-2 text-sm leading-6 text-ink">{showAmounts ? "Transfer · GH₵1.00 · Hubtel wallet → MTN MoMo." : "There’s a private update for you. Open Alfred to review."}</p>
  </div>;
}

export function NotificationsSection({ ownerId, preview = false, initial }: { ownerId?: string; preview?: boolean; initial?: NotificationSettingsData }) {
  const [data, setData] = useState<NotificationSettingsData | null>(initial ?? null);
  const [loading, setLoading] = useState(!initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [supported, setSupported] = useState(preview);
  const [currentDevice, setCurrentDevice] = useState<string | null>(null);
  const [deviceChecked, setDeviceChecked] = useState(preview);
  const [reconnectNeeded, setReconnectNeeded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [deviceUnknown, setDeviceUnknown] = useState(false);
  const [busyLabel, setBusyLabel] = useState("Saving…");
  const session = useRef({ generation: 0, owner: ownerId ?? initial?.ownerId, active: true, busy: false });
  const visibleData = data && (!ownerId || data.ownerId === ownerId) ? data : null;
  const preferences = visibleData?.preferences ?? EMPTY_NOTIFICATION_PREFERENCES;
  const pushReady = preview || (!!visibleData?.push.configured && visibleData.push.deliveryEnabled && visibleData.push.recoveryReady === true);
  const deviceReady = preview || (!!visibleData?.push.configured && visibleData.push.deliveryEnabled);
  const currentLinked = visibleData && currentDevice && !reconnectNeeded;
  const browserStatus = deviceUnknown ? "Device status couldn’t be checked" : !deviceChecked ? "Checking this device…" : reconnectNeeded ? "Reconnect needed" : currentLinked ? "This device is connected" : "Not enabled on this device";

  useEffect(() => {
    const activeSession = session.current;
    const generation = ++activeSession.generation;
    activeSession.active = true;
    activeSession.owner = ownerId ?? initial?.ownerId;
    activeSession.busy = false;
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && generation === session.current.generation;
    if (!preview) void Promise.resolve().then(async () => {
      if (!current()) return;
      setLoading(true); setBusy(false); setError(""); setNotice(""); setCurrentDevice(null); setDeviceChecked(false); setReconnectNeeded(false); setDeviceUnknown(false); setSupported(browserCanNotify());
      try {
        const next = await readNotificationSettings(ownerId, controller.signal);
        if (!current()) return;
        session.current.owner = next.ownerId;
        setData(next); setLoading(false);
        // Inspect existing registration only. Rendering never asks permission or links a device.
        if (!browserCanNotify()) { setDeviceChecked(true); return; }
        try {
          const subscription = await (await existingPushManager())?.getSubscription();
          if (!current()) return;
          if (!subscription) { setDeviceChecked(true); return; }
          if (next.push.configured && next.push.publicKey) setReconnectNeeded(!usesServerKey(subscription, next.push.publicKey));
          const response = await fetch("/api/notifications/subscriptions/status", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json", "x-alfred-owner": next.ownerId }, body: JSON.stringify({ endpoint: subscription.toJSON().endpoint }), signal: controller.signal });
          const result = await response.json().catch(() => null) as { ok?: boolean; device?: { id?: string } | null; ownerId?: string } | null;
          if (current() && response.ok && result?.ok === true && result.ownerId === next.ownerId) {
            const id = result.device?.id;
            if (id !== undefined && (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))) throw new Error();
            setCurrentDevice(id ?? null); setDeviceChecked(true);
          } else if (current()) { setDeviceUnknown(true); setDeviceChecked(true); }
        } catch { if (current()) { setDeviceUnknown(true); setDeviceChecked(true); } }
      } catch {
        if (current()) { setData(null); setLoading(false); setError(unavailable); }
      }
    });
    return () => { controller.abort(); if (generation === activeSession.generation) { activeSession.active = false; activeSession.generation++; activeSession.busy = false; } };
  }, [ownerId, preview, attempt, initial?.ownerId]);

  function begin(label = "Saving…") {
    if (!visibleData || session.current.busy || !session.current.active || session.current.owner !== visibleData.ownerId) return null;
    session.current.busy = true;
    const token = { owner: visibleData.ownerId, generation: session.current.generation };
    setBusy(true); setBusyLabel(label); setError(""); setNotice("");
    return token;
  }
  function current(token: { owner: string; generation: number }) {
    return session.current.active && session.current.owner === token.owner && session.current.generation === token.generation;
  }
  function finish(token: { owner: string; generation: number }) {
    if (current(token)) { session.current.busy = false; setBusy(false); }
  }
  async function savePreference(key: PreferenceKey, value: boolean) {
    const token = begin(); if (!token || !visibleData) return;
    try {
      let next: NotificationPreferences;
      if (preview) next = { ...preferences, [key]: value };
      else {
        const result = await sendNotificationJson("/api/notifications", "PATCH", { [key]: value }, token.owner);
        next = confirmedPreferences(result.preferences);
        if (next[key] !== value) throw new Error("That choice couldn’t be confirmed. Reload your choices to check it.");
      }
      if (!current(token)) return;
      setData(previous => previous?.ownerId === token.owner ? { ...previous, preferences: next } : previous);
      setNotice(preview ? "Sample choice updated. Nothing will be sent." : "Saved.");
    } catch (cause) { if (current(token)) setError(cause instanceof NotificationRecoveryUnavailable ? cause.message : "That choice couldn’t be confirmed. Reload your choices to check it."); }
    finally { finish(token); }
  }
  async function allowThisBrowser() {
    const token = begin("Connecting…"); if (!token || !visibleData) return;
    try {
      let deviceId: string;
      if (preview) deviceId = "00000000-0000-4000-8000-000000000001";
      else {
        const key = visibleData.push.publicKey;
        if (!key || !pushReady || !browserCanNotify()) throw new Error("Device notifications aren’t ready yet. Your chat choices still work.");
        deviceId = await connectNotificationDevice(key, {
          requestPermission: () => Notification.requestPermission(),
          register: async () => {
            if (!current(token)) throw new Error("Your account changed. Reload to continue.");
            const manager = hostPushManager();
            if (manager) return { pushManager: manager };
            await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
            return navigator.serviceWorker.ready;
          },
          save: async (subscription) => {
            if (!current(token)) throw new Error("Your account changed. Reload to continue.");
            const result = await sendNotificationJson("/api/notifications/subscriptions", "POST", subscription, token.owner);
            if (!result.deviceId) throw new Error("The device could not be linked.");
            return { deviceId: result.deviceId };
          },
        });
      }
      if (!current(token)) return;
      setCurrentDevice(deviceId); setDeviceChecked(true); setDeviceUnknown(false); setReconnectNeeded(false);
      // The Enable action explicitly enables payment notifications, not other choices.
      let next = { ...preferences, paymentPush: true };
      if (!preview) {
        try {
          const result = await sendNotificationJson("/api/notifications", "PATCH", { paymentPush: true }, token.owner);
          next = confirmedPreferences(result.preferences);
          if (!next.paymentPush) throw new Error();
        } catch { throw new Error("This device is connected. Payment notification settings couldn’t be confirmed. Reload your choices to check them."); }
      }
      if (!current(token)) return;
      setData(previous => previous?.ownerId === token.owner ? { ...previous, preferences: next, devices: previous.devices.some(device => device.id === deviceId) ? previous.devices : [...previous.devices, { id: deviceId, createdAt: new Date().toISOString() }] } : previous);
      setNotice(preview ? "Sample device enabled. Nothing will be sent." : "Payment notifications enabled on this device.");
    } catch (cause) {
      if (!current(token)) return;
      if (cause instanceof ExistingNotificationConnection) setReconnectNeeded(true);
      setError(cause instanceof Error ? cause.message : "This device could not be connected. Try again.");
    } finally { finish(token); }
  }
  async function removeDevice(id: string) {
    const token = begin(); if (!token || !visibleData || !visibleData.devices.some(device => device.id === id) && id !== currentDevice) { if (token) finish(token); return; }
    try {
      if (!preview) {
        await sendNotificationJson("/api/notifications/subscriptions", "DELETE", { id }, token.owner);
        if (!current(token)) return;
        if (id === currentDevice) {
          try { await (await (await existingPushManager())?.getSubscription())?.unsubscribe(); } catch { /* Server has already disabled delivery. */ }
        }
      }
      if (!current(token)) return;
      if (id === currentDevice) { setCurrentDevice(null); setReconnectNeeded(false); }
      setData(previous => previous?.ownerId === token.owner ? { ...previous, devices: previous.devices.filter(device => device.id !== id) } : previous);
      setNotice(preview ? "Sample device removed. Nothing was changed on your account." : "Notifications are off on that device.");
    } catch { if (current(token)) setError("The device could not be disconnected. Please try again."); }
    finally { finish(token); }
  }
  async function testNotification() {
    const token = begin("Sending test…"); if (!token || !currentDevice || !currentLinked) { if (token) finish(token); return; }
    try {
      if (preview) { setNotice("Sample test only. No notification was sent."); return; }
      const response = await fetch("/api/notifications/test", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json", "x-alfred-owner": token.owner }, body: JSON.stringify({ deviceId: currentDevice }) });
      const result = await response.json().catch(() => null) as { ok?: boolean; status?: string } | null;
      if (!current(token)) return;
      if (response.status === 429 && result?.status === "throttled") throw new Error("Please wait 30 seconds before sending another test.");
      if (!response.ok || result?.ok !== true || !["accepted", "unconfirmed"].includes(result.status ?? "")) throw new Error("The test could not be sent. Please try again.");
      setNotice(result.status === "accepted" ? "Test sent. Check this device’s notifications." : "The test result couldn’t be confirmed. Check this device before trying again.");
    } catch (cause) { if (current(token)) setError(cause instanceof Error ? cause.message : "The test could not be sent. Try again."); }
    finally { finish(token); }
  }
  function resetPreview() {
    if (!preview || !visibleData) return;
    setData({ ...visibleData, preferences: { ...EMPTY_NOTIFICATION_PREFERENCES }, devices: [] });
    setCurrentDevice(null); setReconnectNeeded(false); setError(""); setNotice("Sample choices reset. Nothing will be sent.");
  }

  return <div className="flex flex-col gap-5">
    <Card title="Alfred in chat">
      {loading || !visibleData ? <p className="flex items-center gap-2 text-sm text-muted" role="status">{loading ? <><Spinner />Loading your choices…</> : "Your choices couldn’t be loaded."}</p> : <div className="divide-y divide-line">
        <NotificationChoice id="payment-mentions" title="Money in" description="Announce incoming payment alerts." checked={preferences.paymentMentions} disabled={busy} onChange={value => void savePreference("paymentMentions", value)} />
        <NotificationChoice id="outgoing-mentions" title="Money out" description="Announce outgoing payment alerts." checked={preferences.outgoingMentions} disabled={busy} onChange={value => void savePreference("outgoingMentions", value)} />
      </div>}
      {!loading && !visibleData ? <Button className="mt-3" onClick={() => setAttempt(value => value + 1)}>Try again</Button> : null}
    </Card>
    <Card title="Device notifications">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted" role="status">{browserStatus}</p>
        <div className={`flex flex-wrap gap-2 ${currentLinked ? "" : "alfred-buttonGroup--mobileStack"}`}>
          {currentLinked ? <><Button onClick={() => void testNotification()} disabled={busy || !deviceReady}>Send test</Button><Button variant="ghost" onClick={() => void removeDevice(currentDevice!)} disabled={busy}>Turn off this device</Button></> : <Button variant="primary" className="alfred-button--mobileFull" onClick={() => void allowThisBrowser()} disabled={busy || !visibleData || !pushReady || (!preview && (!supported || reconnectNeeded))}>Enable notifications</Button>}
        </div>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted">Tap a payment alert to continue in Chat.</p>
      {reconnectNeeded ? <p className="mt-3 text-xs leading-5 text-muted">An older connection needs to be removed first. Keep this account in a separate browser profile if the connection belongs to someone else.</p> : !supported && !preview ? <p className="mt-3 text-xs leading-5 text-muted">On iPhone or iPad, add Alfred to your Home Screen and open it there first.</p> : !pushReady && !preview && visibleData ? <p className="mt-3 text-xs leading-5 text-muted">Device notifications aren’t ready yet. Your chat choices still work.</p> : null}
      {visibleData && (currentLinked || preferences.paymentPush || visibleData.devices.length > 0) ? <div className="mt-4 border-t border-line"><NotificationChoice id="payment-push" title="Payment notifications" description="Applies to your connected devices." checked={preferences.paymentPush} disabled={busy || (!preferences.paymentPush && !pushReady)} onChange={value => void savePreference("paymentPush", value)} /></div> : null}
      {visibleData ? <div className="mt-4 border-t border-line"><NotificationChoice id="payment-preview" title="Show amounts in notifications" description="Shows amounts and matched account names on your lock screen. Applies to your connected devices." checked={preferences.paymentPreview} disabled={busy} onChange={value => void savePreference("paymentPreview", value)} /></div> : null}
      {currentLinked ? <details className="mt-3 border-t border-line pt-3"><summary className="min-h-11 cursor-pointer py-3 text-xs font-medium text-muted">Notification preview</summary><DiscreetNotificationPreview showAmounts={preferences.paymentPreview} /></details> : null}
      {visibleData && visibleData.devices.some(device => device.id !== currentDevice) ? <details className="mt-3 border-t border-line pt-3"><summary className="min-h-11 cursor-pointer py-3 text-xs font-medium text-muted">Other connected devices</summary><ul className="space-y-2 pb-2">{visibleData.devices.filter(device => device.id !== currentDevice).map((device, index) => <li key={device.id} className="flex items-center justify-between gap-3 text-sm"><span>Device {index + 1}</span><Button size="sm" variant="ghost" onClick={() => void removeDevice(device.id)} disabled={busy}>Remove</Button></li>)}</ul></details> : null}
    </Card>
    <details className="rounded-xl border border-line bg-surface px-5 py-1 sm:px-6">
      <summary className="min-h-11 cursor-pointer py-4 text-sm font-medium text-ink">Reminders</summary>
      {visibleData ? <div className="divide-y divide-line pb-2"><NotificationChoice id="bill-reminders" title="Bill reminders" description="The day before a confirmed bill, at 9am." checked={preferences.billReminders} disabled={busy || (!preferences.billReminders && !pushReady)} onChange={value => void savePreference("billReminders", value)} /><NotificationChoice id="weekly-overview" title="Weekly overview" description="Sunday at 6pm, in your timezone." checked={preferences.weeklyOverview} disabled={busy || (!preferences.weeklyOverview && !pushReady)} onChange={value => void savePreference("weeklyOverview", value)} /></div> : <p className="pb-4 text-xs text-muted">Load your notification choices to manage reminders.</p>}
    </details>
    <div aria-live="polite" className="px-1">
      {busy ? <p className="flex items-center gap-2 text-xs text-muted" role="status"><Spinner />{busyLabel}</p> : null}
      {error ? <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-danger" role="alert">{error}</p><Button size="sm" variant="ghost" onClick={() => setAttempt(value => value + 1)} disabled={busy}>Reload choices</Button></div> : null}
      {notice ? <p className="text-xs text-muted" role="status">{notice}</p> : null}
      {preview ? <div className="mt-2 flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-faint">Demo · sample choices only. Nothing will be sent.</p><Button size="sm" variant="ghost" onClick={resetPreview} disabled={busy}>Reset sample choices</Button></div> : null}
    </div>
  </div>;
}

function NotificationChoice({ id, title, description, checked, disabled, onChange }: { id: string; title: string; description: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  return <div className="flex items-start justify-between gap-4 py-4">
    <div><p id={`${id}-title`} className="text-sm font-medium text-ink">{title}</p><p id={`${id}-description`} className="mt-1 max-w-md text-xs leading-5 text-muted">{description}</p></div>
    <button type="button" role="switch" aria-checked={checked} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} disabled={disabled} onClick={() => onChange(!checked)} className="grid min-h-11 min-w-11 shrink-0 place-items-center rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:opacity-50"><span aria-hidden="true" className={`relative block h-6 w-11 rounded-full transition ${checked ? "bg-accent" : "bg-surface-2 ring-1 ring-line-strong"}`}><span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${checked ? "left-[22px]" : "left-0.5"}`} /></span></button>
  </div>;
}
