"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Card } from "@/app/components/ui";
import { messageRequest } from "@/app/chat/message-alerts";

export type MessagePreferences = { messagePush: boolean; messagePreview: boolean; messagePushSince: string | null };
const defaults: MessagePreferences = { messagePush: false, messagePreview: false, messagePushSince: null };
export function parseMessagePreferences(value: unknown): MessagePreferences {
  const prefs = value as Record<string, unknown> | null;
  if (!prefs || typeof prefs.messagePush !== "boolean" || typeof prefs.messagePreview !== "boolean" || prefs.messagePushSince !== null && (typeof prefs.messagePushSince !== "string" || !Number.isFinite(Date.parse(prefs.messagePushSince)))) throw new Error("Message notification choices are unavailable.");
  return { messagePush: prefs.messagePush, messagePreview: prefs.messagePreview, messagePushSince: prefs.messagePushSince as string | null };
}

export function MessageNotificationSettings({ ownerId, ready, connected, preview = false }: { ownerId: string; ready: boolean; connected: boolean; preview?: boolean }) {
  const [preferences, setPreferences] = useState<MessagePreferences>(defaults);
  const [loaded, setLoaded] = useState(preview);
  const [loading, setLoading] = useState(!preview), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(""), [attempt, setAttempt] = useState(0);
  const session = useRef({ active: true, busy: false, owner: ownerId });
  useEffect(() => {
    let alive = true;
    session.current = { active: true, busy: false, owner: ownerId };
    if (!preview) void (async () => {
      setLoading(true);
      try {
        const result = await messageRequest<{ preferences: unknown }>(ownerId, "GET");
        if (alive) { setPreferences(parseMessagePreferences(result.preferences)); setLoaded(true); setError(""); setUncertain(false); }
      } catch { if (alive) setError("Message notification choices could not be loaded. Reload them to try again."); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; session.current.active = false; };
  }, [ownerId, preview, attempt]);
  async function save(key: "messagePush" | "messagePreview", enabled: boolean) {
    if (session.current.busy || uncertain || loading || !loaded || session.current.owner !== ownerId) return;
    session.current.busy = true; setBusy(true); setError("");
    try {
      const next = preview ? { ...preferences, [key]: enabled } : parseMessagePreferences((await messageRequest<{ preferences: unknown }>(ownerId, "PATCH", { [key]: enabled })).preferences);
      if (session.current.active && session.current.owner === ownerId) setPreferences(next);
    } catch {
      if (session.current.active && session.current.owner === ownerId) { setUncertain(true); setError("The change couldn’t be confirmed. Reload these choices before trying again."); }
    } finally { if (session.current.active && session.current.owner === ownerId) { session.current.busy = false; setBusy(false); } }
  }
  const disabled = busy || loading || uncertain || !loaded;
  return <Card title="Messages from Alfred">
    <p className="text-sm leading-6 text-muted">A badge and an alert show new messages while you’re on another Alfred tab. Reading Chat clears them.</p>
    {loading ? <p className="mt-3 text-xs text-muted" role="status">Loading message choices…</p> : !loaded ? <p className="mt-3 text-xs text-muted">Your message choices couldn’t be loaded.</p> : <div className="mt-3 divide-y divide-line">
      <MessageChoice id="message-push" title="Notify me about Alfred’s messages" description="Applies to connected devices when you aren’t reading Chat. No notification reply is needed." checked={preferences.messagePush} disabled={disabled || !preferences.messagePush && (!ready || !connected)} change={value => void save("messagePush", value)} />
      <MessageChoice id="message-preview" title="Show message previews" description="Can show message text, including financial details, on your lock screen. Hidden by default." checked={preferences.messagePreview} disabled={disabled} change={value => void save("messagePreview", value)} />
    </div>}
    {!connected && !preview ? <p className="mt-2 text-xs text-muted">Connect a notification device above to receive messages outside Alfred.</p> : !ready && !preview ? <p className="mt-2 text-xs text-muted">Device delivery needs a healthy recovery check-in. In-app message alerts still work.</p> : null}
    <div className="mt-3 rounded-xl border border-line bg-bg p-4" aria-label="Example message notification"><p className="text-xs font-medium text-muted">Alfred</p><p className="mt-2 text-sm">{preferences.messagePreview ? "I’ve got a new update for you." : "Alfred sent you a message. Open Chat to read it."}</p></div>
    {busy ? <p className="mt-3 text-xs text-muted" role="status">Saving message choices…</p> : null}
    {error ? <div className="mt-3"><p className="text-sm text-danger" role="alert">{error}</p><Button size="sm" variant="ghost" onClick={() => { setAttempt(value => value + 1); }} disabled={busy}>Reload choices</Button></div> : null}
  </Card>;
}

function MessageChoice({ id, title, description, checked, disabled, change }: { id: string; title: string; description: string; checked: boolean; disabled: boolean; change: (value: boolean) => void }) {
  return <div className="flex items-start justify-between gap-4 py-4"><div><p id={`${id}-title`} className="text-sm font-medium">{title}</p><p id={`${id}-description`} className="mt-1 max-w-md text-xs leading-5 text-muted">{description}</p></div><button type="button" role="switch" aria-checked={checked} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} disabled={disabled} onClick={() => change(!checked)} className="grid min-h-11 min-w-11 shrink-0 place-items-center rounded-lg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"><span aria-hidden="true" className={`relative block h-6 w-11 rounded-full ${checked ? "bg-accent" : "bg-surface-2 ring-1 ring-line-strong"}`}><span className={`absolute top-0.5 size-5 rounded-full bg-white shadow ${checked ? "left-[22px]" : "left-0.5"}`} /></span></button></div>;
}
