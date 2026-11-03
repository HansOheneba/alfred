"use client";

import { useEffect, useState } from "react";

import { Button, Card } from "@/app/components/ui";
import { Spinner } from "@/app/components/status";
import type { NotificationPreferences } from "@/lib/notifications/store";

export const EMPTY_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  paymentMentions: false, paymentPush: false, billReminders: false, weeklyOverview: false,
  paymentMentionsSince: null, paymentPushSince: null, billRemindersSince: null, weeklyOverviewSince: null,
};
export type NotificationSettingsData = {
  ownerId: string;
  preferences: NotificationPreferences;
  push: { configured: boolean; publicKey: string | null; deliveryEnabled: boolean; schedulesEnabled: boolean; recoveryReady?: boolean };
  devices: { id: string; createdAt: string }[];
};
type PreferenceKey = "paymentMentions" | "paymentPush" | "billReminders" | "weeklyOverview";
const preferenceKeys: PreferenceKey[] = ["paymentMentions", "paymentPush", "billReminders", "weeklyOverview"];
const unavailable = "Notification settings could not be loaded. Please try again.";

/** Ignore all extra server fields, including subscription endpoints or private keys. */
export function parseNotificationSettings(value: unknown, expectedOwner?: string): NotificationSettingsData {
  const payload = value as Record<string, unknown> | null;
  const prefs = payload?.preferences as Record<string, unknown> | null;
  const push = payload?.push as Record<string, unknown> | null;
  if (payload?.ok !== true || typeof payload.ownerId !== "string" || !prefs || !push || !Array.isArray(payload.devices)) throw new Error(unavailable);
  if (expectedOwner && payload.ownerId !== expectedOwner) throw new Error("Your session changed. Reload this page to continue.");
  if (!preferenceKeys.every((key) => typeof prefs[key] === "boolean") || !["configured", "deliveryEnabled", "schedulesEnabled"].every((key) => typeof push[key] === "boolean")) throw new Error(unavailable);
  if (push.recoveryReady !== undefined && typeof push.recoveryReady !== "boolean") throw new Error(unavailable);
  if (push.publicKey !== null && (typeof push.publicKey !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(push.publicKey))) throw new Error(unavailable);
  const preferences = { ...EMPTY_NOTIFICATION_PREFERENCES };
  for (const key of preferenceKeys) {
    preferences[key] = prefs[key] as boolean;
    const sinceKey = `${key}Since` as keyof Pick<NotificationPreferences, "paymentMentionsSince" | "paymentPushSince" | "billRemindersSince" | "weeklyOverviewSince">;
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
  constructor(){super("Scheduled push recovery is not ready. Device notifications cannot be enabled yet; Alfred’s in-app mentions remain available.");}
}
async function sendNotificationJson(path: string, method: string, body: unknown, expectedOwner: string) {
  const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json", "x-alfred-owner": expectedOwner }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => null) as { ok?: boolean; text?: string; deviceId?: string; device?: { id: string; createdAt: string } | null; ownerId?: string; recoveryReady?: boolean } | null;
  if (!response.ok && payload?.recoveryReady === false) throw new NotificationRecoveryUnavailable();
  if (!response.ok || payload?.ok !== true) throw new Error("That notification choice could not be saved. Please try again.");
  return payload;
}
function browserCanNotify(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
}
function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(value));
}

export function DiscreetNotificationPreview() {
  return (
    <div className="rounded-2xl border border-line-strong bg-bg p-4" aria-label="Example lock screen notification">
      <div className="flex items-center gap-2 text-xs font-medium text-muted"><span className="grid size-6 place-items-center rounded-lg bg-brand-soft text-brand" aria-hidden="true">A</span>Alfred<span className="ml-auto font-normal text-faint">now</span></div>
      <p className="mt-3 text-sm leading-6 text-ink">There’s a private update for you. Open Alfred to review.</p>
      <p className="mt-2 text-xs text-faint">Preview · no names, amounts or message text</p>
    </div>
  );
}

export function NotificationsSection({ ownerId, preview = false, initial }: { ownerId?: string; preview?: boolean; initial?: NotificationSettingsData }) {
  const [data, setData] = useState<NotificationSettingsData | null>(initial ?? null);
  const [choices, setChoices] = useState<NotificationPreferences>(initial?.preferences ?? EMPTY_NOTIFICATION_PREFERENCES);
  const [loading, setLoading] = useState(!initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [supported, setSupported] = useState(preview);
  const [currentDevice, setCurrentDevice] = useState<string | null>(null);
  const [deviceChecked, setDeviceChecked] = useState(preview);
  const [reconnectNeeded, setReconnectNeeded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const dirty = !!data && preferenceKeys.some((key) => choices[key] !== data.preferences[key]);
  const pushReady = !!data?.push.configured && data.push.deliveryEnabled && data.push.recoveryReady === true;
  const browserStatusLabel = !deviceChecked ? "Browser status not verified" : reconnectNeeded ? "Browser needs reconnecting" : `${preview ? "Sample browser" : "Browser"} ${currentDevice ? "linked" : "not linked"}`;

  useEffect(() => {
    if (preview) return;
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return null;
      setLoading(true); setError(""); setCurrentDevice(null); setDeviceChecked(false); setReconnectNeeded(false); setSupported(browserCanNotify());
      return readNotificationSettings(ownerId, controller.signal);
    }).then(async (next) => {
      if (controller.signal.aborted || !next) return;
      setData(next); setChoices(next.preferences); setLoading(false);
      // Inspect only an existing registration. Opening Settings never prompts,
      // registers, subscribes, sends a push or changes account preferences.
      if (!browserCanNotify()) { setDeviceChecked(true); return; }
      try {
        const registration = await navigator.serviceWorker.getRegistration("/");
        const subscription = await registration?.pushManager.getSubscription();
        if (controller.signal.aborted) return;
        if (!subscription) { setDeviceChecked(true); return; }
        if (next.push.configured && next.push.publicKey) setReconnectNeeded(!usesServerKey(subscription, next.push.publicKey));
        const response = await fetch("/api/notifications/subscriptions/status", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json", "x-alfred-owner": next.ownerId }, body: JSON.stringify({ endpoint: subscription.endpoint }), signal: controller.signal });
        const result = await response.json().catch(() => null) as { ok?: boolean; device?: { id?: string } | null; ownerId?: string } | null;
        if (!controller.signal.aborted && response.ok && result?.ok === true && result.ownerId === next.ownerId) { setCurrentDevice(result.device?.id ?? null); setDeviceChecked(true); }
      } catch { /* Browser diagnostics do not hide valid account choices. */ }
    }).catch(() => {
      if (!controller.signal.aborted) { setData(null); setLoading(false); setError(unavailable); }
    });
    return () => controller.abort();
  }, [ownerId, preview, attempt]);

  async function saveChoices() {
    if (!data) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (preview) {
        setData({ ...data, preferences: { ...choices } });
        setNotice("Preview choices saved for this visit. No account settings were saved and nothing will be sent.");
      } else {
        const patch = Object.fromEntries(preferenceKeys.filter((key) => choices[key] !== data.preferences[key]).map((key) => [key, choices[key]]));
        await sendNotificationJson("/api/notifications", "PATCH", patch, data.ownerId);
        const next = await readNotificationSettings(ownerId);
        setData(next); setChoices(next.preferences); setNotice("Notification choices saved. Only new eligible updates will be included.");
      }
    } catch (cause) { setError(cause instanceof NotificationRecoveryUnavailable ? cause.message : "The saved notification choices could not be confirmed. Reload this page to check them before trying again."); }
    finally { setBusy(false); }
  }
  function resetPreview() {
    if (!preview || !data) return;
    const preferences = { ...EMPTY_NOTIFICATION_PREFERENCES };
    setChoices(preferences);
    setData({ ...data, preferences });
    setError("");
    setNotice("Preview reset. All four choices are off. No account settings were changed.");
  }
  async function allowThisBrowser() {
    if (!data) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (preview) {
        setCurrentDevice("00000000-0000-4000-8000-000000000001");
        setDeviceChecked(true);
        setNotice("Browser setup previewed. No permission was requested and no device was registered.");
      } else {
        const key = data.push.publicKey;
        if (!key || !data.push.configured || !browserCanNotify()) throw new Error("This browser is not ready for notifications.");
        const deviceId = await connectNotificationDevice(key, {
          requestPermission: () => Notification.requestPermission(),
          register: async () => {
            await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
            return navigator.serviceWorker.ready;
          },
          save: async (subscription) => {
            const result = await sendNotificationJson("/api/notifications/subscriptions", "POST", subscription, data.ownerId);
            if (!result.deviceId) throw new Error("The device could not be registered.");
            return { deviceId: result.deviceId };
          },
        });
        setCurrentDevice(deviceId);
        setDeviceChecked(true);
        setReconnectNeeded(false);
        const next = await readNotificationSettings(ownerId); setData(next);
        setNotice("This browser is linked. Choose which updates you want above.");
      }
    } catch (cause) {
      if (cause instanceof ExistingNotificationConnection) setReconnectNeeded(true);
      setError(cause instanceof Error ? cause.message : "This browser could not be linked.");
    }
    finally { setBusy(false); }
  }
  async function removeDevice(id: string) {
    if (!data) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (!preview) {
        await sendNotificationJson("/api/notifications/subscriptions", "DELETE", { id }, data.ownerId);
        if (id === currentDevice) {
          try {
            const registration = await navigator.serviceWorker.getRegistration("/");
            await (await registration?.pushManager.getSubscription())?.unsubscribe();
          } catch { /* Server delivery is already disabled even if browser cleanup fails. */ }
        }
      }
      if (id === currentDevice) { setCurrentDevice(null); setReconnectNeeded(false); }
      setData({ ...data, devices: data.devices.filter((device) => device.id !== id) });
      setNotice(preview ? "Device removed from this preview only." : "Notification delivery to that device is off.");
    } catch { setError("The device could not be removed. Please try again."); }
    finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-5">
      <Card title="When Alfred checks in">
        <p className="text-sm leading-6 text-muted">Let Alfred mention new payment alerts in chat, and choose which discreet nudges can reach your devices. Everything starts off until you choose it.</p>
        {loading ? <p className="mt-4 flex items-center gap-2 text-sm text-muted" role="status"><Spinner />Loading notification choices…</p> : null}
        {data ? <>
          <div className="mt-5 divide-y divide-line">
            <NotificationChoice id="payment-mentions" title="Mention incoming payments in chat" description="Alfred speaks up when a new incoming alert is detected. Uncertain alerts are clearly marked for review." checked={choices.paymentMentions} disabled={busy} onChange={(value) => setChoices({ ...choices, paymentMentions: value })} />
            <NotificationChoice id="payment-push" title="Payment nudges" description="A discreet nudge for new payment alerts, including overnight. Details stay inside Alfred." checked={choices.paymentPush} disabled={busy || (!preview && !choices.paymentPush && !pushReady)} onChange={(value) => setChoices({ ...choices, paymentPush: value })} />
            <NotificationChoice id="bill-reminders" title="Bill reminders" description="A reminder at 9am the day before a confirmed bill, in your timezone." checked={choices.billReminders} disabled={busy || (!preview && !choices.billReminders && !pushReady)} onChange={(value) => setChoices({ ...choices, billReminders: value })} />
            <NotificationChoice id="weekly-overview" title="Weekly overview" description="A Sunday check-in at 6pm in your timezone, when your records are up to date." checked={choices.weeklyOverview} disabled={busy || (!preview && !choices.weeklyOverview && !pushReady)} onChange={(value) => setChoices({ ...choices, weeklyOverview: value })} />
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-end gap-3 border-t border-line pt-4">
            {dirty ? <p className="mr-auto text-xs text-muted">Unsaved notification choices</p> : null}
            {preview ? <Button onClick={resetPreview} disabled={busy}>Reset preview choices</Button> : null}
            <Button variant="primary" onClick={() => void saveChoices()} disabled={!dirty || busy} aria-busy={busy}>{busy ? <Spinner /> : null}{preview ? "Save preview choices" : "Save notification choices"}</Button>
          </div>
          {preview ? <p className="mt-3 text-xs leading-5 text-muted">Try all four choices here. They are simulated for this visit, stay while you browse this preview, and reset when you reload. Nothing will be sent.</p> : !pushReady ? <p className="mt-3 text-xs leading-5 text-muted">Scheduled push recovery is not ready. New device notifications stay off until it has recently checked in. Alfred’s in-app mentions remain available, and existing device choices can be turned off.</p> : <p className="mt-3 text-xs leading-5 text-muted">Scheduled recovery has recently checked in. It can pick up pending nudges without waiting for another SMS.</p>}
        </> : null}
        {error ? <p className="mt-4 text-sm text-danger" role="alert">{error}</p> : null}
        {notice ? <p className="mt-4 text-sm text-success" role="status" aria-live="polite">{notice}</p> : null}
        {!loading && !data ? <Button className="mt-3" onClick={() => setAttempt((value) => value + 1)}>Try again</Button> : null}
      </Card>

      <Card title="On this browser">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${currentDevice && !reconnectNeeded ? "bg-success/10 text-success" : "bg-surface-2 text-muted"}`}>{browserStatusLabel}</span>
            <p className="mt-3 text-sm leading-6 text-muted">Browser permission and your account choices are separate. You can keep Alfred’s chat mentions on while device notifications stay off.</p>
            {reconnectNeeded ? <p className="mt-3 text-xs leading-5 text-muted">Turn off the existing browser connection before connecting again. If it belongs to another account, use a separate browser profile. Opening this page does not replace it.</p> : null}
            {!supported && !preview ? <p className="mt-3 text-xs leading-5 text-muted">Notifications aren’t available in this browser context. On iPhone or iPad, add Alfred to your Home Screen first.</p> : null}
            {data && !data.push.configured ? <p className="mt-3 text-xs leading-5 text-muted">Browser notifications are not ready on this Alfred server yet.</p> : null}
            {data && !data.push.deliveryEnabled ? <p className="mt-3 text-xs leading-5 text-muted">Push delivery is currently off. A linked browser alone does not mean a notification was sent or shown.</p> : null}
            <div className="mt-4 flex flex-wrap gap-2">
              {currentDevice ? <Button onClick={() => void removeDevice(currentDevice)} disabled={busy}>Turn off this browser</Button> : <Button onClick={() => void allowThisBrowser()} disabled={busy || !data || (!preview && (!supported || !data.push.configured))} aria-busy={busy}>{preview ? "Preview browser setup" : "Allow notifications on this browser"}</Button>}
            </div>
          </div>
          <div className="w-full sm:w-64"><DiscreetNotificationPreview /></div>
        </div>
        {data && data.devices.length > 0 ? <div className="mt-5 border-t border-line pt-4"><p className="text-xs font-medium text-muted">Linked devices</p><ul className="mt-2 space-y-2">{data.devices.map((device, index) => <li key={device.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-bg px-3 py-2 text-sm"><span>{device.id === currentDevice ? "This browser" : `Device ${index + 1}`}<span className="ml-2 text-xs text-faint">added {dateLabel(device.createdAt)}</span></span><Button size="sm" variant="ghost" onClick={() => void removeDevice(device.id)} disabled={busy} aria-label={`Remove device ${index + 1}`}>Remove</Button></li>)}</ul></div> : null}
      </Card>
      <p className="px-1 text-xs leading-5 text-muted">Notification previews never include a payment amount, a person’s name, a balance or SMS text. Open Alfred and sign in to see the details. Clicking a notification does not move money or change a category.</p>
    </div>
  );
}

function NotificationChoice({ id, title, description, checked, disabled, onChange }: { id: string; title: string; description: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  return <div className="flex items-start justify-between gap-4 py-4">
    <div><p id={`${id}-title`} className="text-sm font-medium text-ink">{title}</p><p id={`${id}-description`} className="mt-1 max-w-md text-xs leading-5 text-muted">{description}</p></div>
    <button type="button" role="switch" aria-checked={checked} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} disabled={disabled} onClick={() => onChange(!checked)} className="grid min-h-11 min-w-11 shrink-0 place-items-center rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:opacity-50"><span aria-hidden="true" className={`relative block h-6 w-11 rounded-full transition ${checked ? "bg-accent" : "bg-surface-2 ring-1 ring-line-strong"}`}><span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${checked ? "left-[22px]" : "left-0.5"}`} /></span></button>
  </div>;
}
