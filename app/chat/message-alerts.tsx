"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

export const CHAT_READ_EVENT = "alfred:chat-read";
export const CHAT_REFRESH_EVENT = "alfred:chat-refresh";
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export type ChatReadSignal = { ownerId: string; messageId: string | null; active: boolean };
export type MessageUpdates = { ok: true; ownerId: string; initialized: boolean; unreadCount: number; latestMessageId: string | null };

/** A modal can cover Chat while its document stays focused and visible. */
export function chatIsReadable() {
  return document.visibilityState === "visible" && document.hasFocus() && !document.querySelector("dialog[open]");
}

/** An old rendered thread must never keep suppressing a message it hasn't shown. */
export function createVisibleChatGate(ownerId: string, refresh: (latestMessageId: string | null) => void, clock: () => number = Date.now) {
  let known = false, latest: string | null = null;
  let requested: string | null | undefined, requestedAt = -Infinity;
  return {
    observe(messageId: string | null) { known = true; latest = messageId; },
    read(signal: ChatReadSignal, foreground: boolean): ChatReadSignal {
      const visible = signal.ownerId === ownerId && signal.active && foreground;
      const caughtUp = known && signal.messageId === latest;
      if (visible && known && !caughtUp && (requested !== latest || clock() - requestedAt >= 15000)) {
        requested = latest; requestedAt = clock(); refresh(latest);
      }
      if (caughtUp) { requested = undefined; requestedAt = -Infinity; }
      const active = visible && caughtUp;
      return { ownerId, messageId: active ? signal.messageId : null, active };
    },
  };
}

/** Presence is published only by the rendered Chat thread, never by a loading shell. */
export function publishChatRead(signal: ChatReadSignal) {
  if (typeof window === "undefined" || !uuid(signal.ownerId)) return;
  window.dispatchEvent(new CustomEvent<ChatReadSignal>(CHAT_READ_EVENT, { detail: { ...signal, messageId: signal.active && uuid(signal.messageId) ? signal.messageId : null } }));
}

export function parseMessageUpdates(value: unknown, ownerId: string): MessageUpdates {
  const data = value as Record<string, unknown> | null;
  if (data?.ok !== true || data.ownerId !== ownerId || typeof data.initialized !== "boolean" || !Number.isSafeInteger(data.unreadCount) || Number(data.unreadCount) < 0 || data.latestMessageId !== null && !uuid(data.latestMessageId)) throw new Error("Message updates are unavailable.");
  return { ok: true, ownerId, initialized: data.initialized, unreadCount: Math.min(Number(data.unreadCount), 999), latestMessageId: data.latestMessageId as string | null };
}

/** Bounded independently of the financial mutation gate; this sends read receipts only. */
export async function messageRequest<T>(ownerId: string, method: "GET" | "POST" | "PATCH", body?: unknown, request: typeof fetch = fetch, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error("Message updates are unavailable.")); controller.abort(); }, 8000); });
    const cancellation = new Promise<never>((_, reject) => { onAbort = () => { controller.abort(); reject(new Error("Message update was canceled.")); }; if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true }); });
    const operation = (async () => {
      const response = await request("/api/chat/notifications", { method, credentials: "same-origin", cache: "no-store", signal: controller.signal, ...(method === "POST" ? { keepalive: true } : {}),
        ...(method !== "GET" ? { headers: { "content-type": "application/json", "x-alfred-owner": ownerId }, body: JSON.stringify(body) } : {}) });
      const payload = await response.json();
      if (!response.ok || payload?.ok !== true || payload.ownerId !== ownerId) throw new Error(typeof payload?.text === "string" ? payload.text : "Message updates are unavailable.");
      return payload as T;
    })();
    return await Promise.race([operation, deadline, cancellation]);
  } finally { if (timer !== undefined) clearTimeout(timer); if (onAbort) signal?.removeEventListener("abort", onAbort); }
}

// Opaque, owner-scoped dismissals last only for this document's lifetime.
const dismissed = new Map<string, string>();
export function useMessageAlerts(ownerId: string | undefined, current: string) {
  const [state, setState] = useState<{ owner: string; count: number; latest: string | null }>({ owner: "", count: 0, latest: null });
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const view = useRef<ChatReadSignal | null>(null);
  useEffect(() => {
    if (!uuid(ownerId)) return;
    const owner = ownerId, presenceId = crypto.randomUUID();
    const lifetime = new AbortController();
    let active = true, inFlight = false, initialized = false;
    view.current = null;
    const foreground = chatIsReadable;
    const visibleThread = createVisibleChatGate(owner, latestMessageId => {
      window.dispatchEvent(new CustomEvent(CHAT_REFRESH_EVENT, { detail: { ownerId: owner, latestMessageId } }));
    });
    const postRead = async (signal: ChatReadSignal) => {
      if (!active) return;
      const receipt = visibleThread.read(signal, foreground() && current === "chat");
      await messageRequest(owner, "POST", { op: "read", messageId: receipt.messageId, active: receipt.active, presenceId }, fetch, lifetime.signal);
    };
    const refresh = async () => {
      if (!active || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        let data = parseMessageUpdates(await messageRequest(owner, "GET", undefined, fetch, lifetime.signal), owner);
        if (!active) return;
        if (!data.initialized && !initialized) {
          await messageRequest(owner, "POST", { op: "initialize" }, fetch, lifetime.signal);
          initialized = true;
          data = parseMessageUpdates(await messageRequest(owner, "GET", undefined, fetch, lifetime.signal), owner);
        }
        if (!active) return;
        visibleThread.observe(data.latestMessageId);
        setState({ owner, count: data.unreadCount, latest: data.latestMessageId });
        if (view.current?.ownerId === owner && view.current.active && current === "chat" && foreground()) {
          await postRead(view.current);
        }
      } catch { /* Retain a known unread badge; polling failures never fabricate an empty inbox. */ }
      finally { inFlight = false; }
    };
    const read = (event: Event) => {
      const signal = (event as CustomEvent<ChatReadSignal>).detail;
      if (!signal || signal.ownerId !== owner || signal.messageId !== null && !uuid(signal.messageId) || typeof signal.active !== "boolean") return;
      view.current = signal;
      void postRead(signal).then(refresh).catch(() => {});
    };
    const visibility = () => {
      if (view.current?.ownerId === owner) void postRead({ ...view.current, active: foreground() && view.current.active }).catch(() => {});
      void refresh();
    };
    const interval = setInterval(() => { void refresh(); }, 15000);
    window.addEventListener(CHAT_READ_EVENT, read);
    window.addEventListener("focus", visibility);
    window.addEventListener("blur", visibility);
    document.addEventListener("visibilitychange", visibility);
    let disposeRealtime: (() => void) | undefined;
    try {
      const client = createSupabaseBrowserClient();
      const channel = client.channel(`alfred-unread-${owner}-${presenceId}`).on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `owner_id=eq.${owner}` }, payload => {
        const row = payload.new as { owner_id?: string; role?: string };
        if (row.owner_id === owner && row.role === "assistant") void refresh();
      }).subscribe();
      disposeRealtime = () => { void client.removeChannel(channel); };
    } catch { /* Polling is the fallback when realtime isn't configured or available. */ }
    void refresh();
    return () => {
      active = false;
      lifetime.abort();
      if (view.current?.ownerId === owner) void messageRequest(owner, "POST", { op: "read", messageId: null, active: false, presenceId }).catch(() => {});
      view.current = null;
      clearInterval(interval); disposeRealtime?.();
      window.removeEventListener(CHAT_READ_EVENT, read); window.removeEventListener("focus", visibility); window.removeEventListener("blur", visibility); document.removeEventListener("visibilitychange", visibility);
    };
  }, [ownerId, current]);
  const count = state.owner === ownerId ? state.count : 0;
  const latest = state.owner === ownerId ? state.latest : null;
  const dismiss = () => { if (ownerId && latest) { if (dismissed.size > 5) dismissed.clear(); dismissed.set(ownerId, latest); setDismissedId(latest); } };
  const announced = current !== "chat" && count > 0 && !!latest && latest !== dismissedId && latest !== dismissed.get(ownerId ?? "");
  return { count, announced, dismiss };
}

export function ChatUnreadBadge({ count }: { count: number }) {
  return count > 0 ? <span className="alfred-chatUnread"><span aria-hidden="true">{count > 99 ? "99+" : count}</span><span className="sr-only">{count} unread {count === 1 ? "message" : "messages"}</span></span> : null;
}

export function ChatMessageAlert({ count, dismiss }: { count: number; dismiss: () => void }) {
  return <aside className="alfred-chatMessageAlert" aria-label="New message from Alfred"><div role="status" aria-live="polite"><strong>Alfred sent you a message</strong><p>{count} unread {count === 1 ? "message" : "messages"} in Chat.</p></div><Link href="/chat">Open Chat <span aria-hidden="true">↗</span></Link><button type="button" onClick={dismiss} aria-label="Dismiss message alert">×</button></aside>;
}
