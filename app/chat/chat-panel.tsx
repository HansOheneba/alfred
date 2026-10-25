"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { ReplyChart } from "@/app/chat/reply-chart";
import { StatsPanel } from "@/app/chat/stats-panel";
import { AlfredMark } from "@/app/components/app-shell";
import type { ChatChart } from "@/lib/accounts/messages";
import { mergeThread, threadKey, type ThreadMessage } from "@/lib/accounts/thread";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import type { Ledger } from "@/lib/web/ledger";

type ServerMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  channel: "web" | "telegram";
  createdAt: string;
  clientId: string | null;
  chart?: ChatChart | null;
};

type Suggestion = { label: string; text: string; fill?: boolean };

const STARTERS: Suggestion[] = [
  { label: "Where is my money going?", text: "Where is my money going this month?" },
  { label: "How much this week?", text: "How much have I spent this week?" },
  { label: "Log an expense", text: "Spent ", fill: true },
  { label: "Set a budget", text: "Set a budget of ", fill: true },
];

const FOLLOW_UPS: Suggestion[] = [
  { label: "Break it down", text: "Break that down by category" },
  { label: "Compare with last month", text: "How does this compare with last month?" },
  { label: "Tips to spend less", text: "Any tips to spend less?" },
];

const noSubscribe = () => () => {};

export const STATS_EVENT = "alfred:open-stats";

/** Opens the month-at-a-glance sheet from the phone top bar. */
export function StatsButton() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(STATS_EVENT))}
      aria-label="This month at a glance"
      className="grid size-9 place-items-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-gold"
    >
      <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <path d="M5 20V11m7 9V5m7 15v-6" />
      </svg>
    </button>
  );
}

function greeting(name: string): string {
  const hour = new Date().getHours();
  const part = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name}.` : `${part}.`;
}

export function ChatPanel({
  ownerId,
  name,
  initialMessages,
  ledger,
}: {
  ownerId: string;
  name: string;
  initialMessages: ThreadMessage[];
  ledger: Ledger;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<ThreadMessage[]>(initialMessages);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [statsOpen, setStatsOpen] = useState(false);
  // The greeting depends on the viewer's clock, so the server renders a neutral one.
  const hello = useSyncExternalStore(noSubscribe, () => greeting(name), () => "");
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  const stickToBottom = useRef(true);

  // The phone top bar's stats button lives outside this component and asks for the sheet by event.
  useEffect(() => {
    const open = () => setStatsOpen(true);
    window.addEventListener(STATS_EVENT, open);
    return () => window.removeEventListener(STATS_EVENT, open);
  }, []);

  useEffect(() => {
    const node = threadRef.current;
    if (!node || !stickToBottom.current) return;
    node.scrollTop = node.scrollHeight;
  }, [messages, busy]);

  useEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    // An empty box stays one line; measuring it before layout settles can report a huge height.
    if (!text) {
      node.style.height = "";
      return;
    }
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
  }, [text]);

  useEffect(() => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ownerId)) return;
    let active = true;
    const supabase = createSupabaseBrowserClient();
    const channel = supabase
      .channel(`alfred-messages-${ownerId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: `owner_id=eq.${ownerId}` },
        (payload) => {
          const row = payload.new as {
            id?: string;
            owner_id?: string;
            role?: string;
            body?: string;
            channel?: string;
            created_at?: string;
            client_id?: string | null;
            meta?: { chart?: ChatChart } | null;
          };
          if (!active || row.owner_id !== ownerId || !row.id || (row.role !== "user" && row.role !== "assistant")) return;
          if (row.channel !== "web" && row.channel !== "telegram") return;
          const incoming: ThreadMessage = {
            id: row.id,
            role: row.role,
            text: row.body ?? "",
            channel: row.channel,
            createdAt: row.created_at ?? new Date(0).toISOString(),
            clientId: row.client_id ?? null,
            status: "sent",
            chart: row.meta?.chart ?? null,
          };
          setMessages((current) => mergeThread(current, [incoming]));
          if (row.channel === "telegram" && row.role === "assistant") router.refresh();
        },
      )
      .subscribe();
    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [ownerId, router]);

  useEffect(() => {
    let active = true;
    async function refresh() {
      if (document.visibilityState !== "visible" || sending.current) return;
      try {
        const response = await fetch("/api/chat");
        if (!response.ok) return;
        const payload = (await response.json()) as { ok?: boolean; messages?: ServerMessage[] };
        if (!active || !payload.ok || !payload.messages) return;
        const history = payload.messages;
        setMessages((current) => mergeThread(current, history.map(serverMessage)));
      } catch {
        // The thread already shows the last saved messages.
      }
    }
    function onVisible() {
      void refresh();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  function onThreadScroll() {
    const node = threadRef.current;
    if (!node) return;
    stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 96;
  }

  async function send(body: Record<string, unknown>, userText?: string, clientId?: string) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    const bodyClientId = typeof body.clientId === "string" ? body.clientId : undefined;
    const turnId = clientId ?? bodyClientId ?? (userText ? crypto.randomUUID() : undefined);
    if (userText && turnId) {
      setMessages((current) => {
        const exists = current.some((message) => message.role === "user" && message.clientId === turnId);
        if (exists) {
          return current.map((message) =>
            message.role === "user" && message.clientId === turnId ? { ...message, text: userText, status: "sending" } : message,
          );
        }
        return mergeThread(current, [
          {
            id: turnId,
            role: "user",
            text: userText,
            channel: "web",
            createdAt: new Date().toISOString(),
            clientId: turnId,
            status: "sending",
          },
        ]);
      });
      setText((current) => (current.trim() === userText ? "" : current));
      stickToBottom.current = true;
    }
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, clientId: turnId }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        text?: string;
        actionId?: string | null;
        messages?: ServerMessage[];
      };
      if (!response.ok || !payload.ok) {
        if (userText && turnId) markFailed(turnId);
        setError(payload.text || "Alfred could not complete that request.");
        return;
      }
      const incoming = (payload.messages ?? []).map((message, index, all) => {
        const view = serverMessage(message);
        const isLastAssistant = message.role === "assistant" && index === all.length - 1;
        return isLastAssistant ? { ...view, actionId: payload.actionId ?? null } : view;
      });
      setMessages((current) =>
        mergeThread(
          current.map((message) =>
            body.actionId && message.actionId === body.actionId ? { ...message, settled: true } : message,
          ),
          incoming,
        ),
      );
      // Keeps the side panel in step with anything that was just recorded.
      router.refresh();
    } catch {
      if (userText && turnId) markFailed(turnId);
      setError("Alfred could not reach the server.");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  async function uploadImage(file: File) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    const turnId = crypto.randomUUID();
    setMessages((current) =>
      mergeThread(current, [
        { id: turnId, role: "user", text: "📷 Screenshot", channel: "web", createdAt: new Date().toISOString(), clientId: turnId, status: "sending" },
      ]),
    );
    stickToBottom.current = true;
    try {
      const form = new FormData();
      form.set("clientId", turnId);
      form.set("image", await shrinkImage(file));
      const response = await fetch("/api/chat/image", { method: "POST", body: form });
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        text?: string;
        actionId?: string | null;
        messages?: ServerMessage[];
      };
      if (!response.ok || !payload.ok) {
        markFailed(turnId);
        setError(payload.text || "Alfred couldn't read that image.");
        return;
      }
      const incoming = (payload.messages ?? []).map((message, index, all) => {
        const view = serverMessage(message);
        return message.role === "assistant" && index === all.length - 1 ? { ...view, actionId: payload.actionId ?? null } : view;
      });
      setMessages((current) => mergeThread(current, incoming));
      router.refresh();
    } catch {
      markFailed(turnId);
      setError("Alfred could not reach the server.");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  function markFailed(turnId: string) {
    setMessages((current) =>
      current.map((message) =>
        message.role === "user" && message.clientId === turnId ? { ...message, status: "failed" } : message,
      ),
    );
  }

  function submitText(value: string, clientId?: string) {
    const trimmed = value.trim();
    if (!trimmed || sending.current) return;
    void send({ text: trimmed }, trimmed, clientId);
  }

  function pickSuggestion(suggestion: Suggestion) {
    if (suggestion.fill) {
      setText(suggestion.text);
      requestAnimationFrame(() => {
        const node = inputRef.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(suggestion.text.length, suggestion.text.length);
      });
      return;
    }
    submitText(suggestion.text);
  }

  function canRetry(message: ThreadMessage, index: number): boolean {
    if (message.role !== "user" || busy || !message.clientId || message.status === "sending") return false;
    if (message.status === "failed") return true;
    return index === messages.length - 1 && !messages.slice(index + 1).some((item) => item.role === "assistant");
  }

  const last = messages.at(-1);
  const showFollowUps = !busy && last?.role === "assistant" && !(last.actionId && !last.settled) && text.length === 0;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <button
          type="button"
          onClick={() => setStatsOpen(true)}
          aria-label="This month at a glance"
          className="absolute right-3 top-3 z-20 hidden size-9 place-items-center rounded-full border border-line bg-surface/90 text-muted shadow-sm backdrop-blur hover:text-ink focus-visible:outline-2 focus-visible:outline-gold md:grid xl:hidden"
        >
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M5 20V11m7 9V5m7 15v-6" />
          </svg>
        </button>
        <div
          ref={threadRef}
          tabIndex={0}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-line-strong"
          aria-busy={busy}
          onScroll={onThreadScroll}
        >
          {messages.length === 0 ? (
            <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col items-center justify-center px-4 py-10 text-center">
              <AlfredMark size="size-14" />
              <h1 className="mt-5 font-display text-2xl font-medium tracking-tight">{hello || "Hello."}</h1>
              <p className="mt-2 max-w-md text-sm leading-6 text-muted">
                Tell me what you spend or earn and I&apos;ll keep the books. Ask where your money goes and I&apos;ll tell you honestly. This is the same conversation as Telegram.
              </p>
              <div className="mt-8 grid w-full max-w-lg grid-cols-1 gap-2 sm:grid-cols-2">
                {STARTERS.map((suggestion) => (
                  <button
                    key={suggestion.label}
                    type="button"
                    onClick={() => pickSuggestion(suggestion)}
                    className="rounded-2xl border border-line bg-surface px-4 py-3 text-left text-sm text-ink transition hover:border-gold/40 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-gold"
                  >
                    {suggestion.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 pb-6 pt-6 sm:px-6 md:pt-14 xl:pt-8" role="log" aria-label="Conversation" aria-relevant="additions">
              {messages.map((message, index) =>
                message.role === "assistant" ? (
                  <article key={threadKey(message)} className="min-w-0">
                    {message.channel === "telegram" ? (
                      <p className="mb-1.5">
                        <TelegramBadge />
                      </p>
                    ) : null}
                    <div>
                      <p className="whitespace-pre-wrap text-base leading-7 text-ink">{message.text}</p>
                      {message.chart ? <ReplyChart chart={message.chart} /> : null}
                      {message.actionId && !message.settled ? (
                        <div className="mt-3 flex gap-2">
                          <button
                            type="button"
                            disabled={busy}
                            className="h-8 rounded-full bg-gold px-4 text-xs font-medium text-gold-ink hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:opacity-40"
                            onClick={() => void send({ decision: "confirm", actionId: message.actionId, clientId: `confirm-${message.actionId}` })}
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            className="h-8 rounded-full border border-line-strong px-4 text-xs text-ink hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:opacity-40"
                            onClick={() => void send({ decision: "cancel", actionId: message.actionId, clientId: `cancel-${message.actionId}` })}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </article>
                ) : (
                  <article key={threadKey(message)} className="flex flex-col items-end">
                    {message.channel === "telegram" ? (
                      <span className="mb-1">
                        <TelegramBadge />
                      </span>
                    ) : null}
                    <div
                      className={`max-w-[85%] rounded-2xl bg-surface-2 px-4 py-2.5 text-base leading-7 text-ink ${
                        message.status === "sending" ? "opacity-70" : ""
                      }`}
                    >
                      <p className="whitespace-pre-wrap">{message.text}</p>
                    </div>
                    {canRetry(message, index) ? (
                      <button
                        type="button"
                        className="mt-1.5 text-xs text-danger underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-gold"
                        onClick={() => submitText(message.text, message.clientId ?? undefined)}
                      >
                        Not sent · Retry
                      </button>
                    ) : null}
                  </article>
                ),
              )}
              {busy ? (
                <div className="flex items-center gap-3" role="status" aria-label="Alfred is thinking">
                  <span className="relative">
                    <span className="alfred-avatar-glow pointer-events-none absolute -inset-2 rounded-full" aria-hidden="true" />
                    <AlfredMark size="size-7" />
                  </span>
                  <span className="flex gap-1" aria-hidden="true">
                    <span className="alfred-dot size-1.5 rounded-full bg-gold" />
                    <span className="alfred-dot size-1.5 rounded-full bg-gold [animation-delay:0.15s]" />
                    <span className="alfred-dot size-1.5 rounded-full bg-gold [animation-delay:0.3s]" />
                  </span>
                </div>
              ) : null}
              {error ? (
                <p className="text-sm text-danger" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          )}
        </div>

        <form
          className="shrink-0 bg-bg"
          onSubmit={(event) => {
            event.preventDefault();
            submitText(text);
          }}
        >
          <div className="mx-auto w-full max-w-3xl px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
            {showFollowUps ? (
              <div className="-mx-4 mb-2 flex gap-2 overflow-x-auto px-4 pb-1">
                {FOLLOW_UPS.map((suggestion) => (
                  <button
                    key={suggestion.label}
                    type="button"
                    onClick={() => pickSuggestion(suggestion)}
                    className="shrink-0 rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-muted transition hover:border-gold/40 hover:text-ink focus-visible:outline-2 focus-visible:outline-gold"
                  >
                    {suggestion.label}
                  </button>
                ))}
              </div>
            ) : null}
            <label className="sr-only" htmlFor="alfred-message">
              Message Alfred
            </label>
            <div className="rounded-[28px] border border-line-strong bg-surface px-3 pb-2 pt-3 shadow-sm transition focus-within:border-gold/50">
              <textarea
                ref={inputRef}
                id="alfred-message"
                className="block max-h-[200px] min-h-7 w-full resize-none bg-transparent px-2 text-base leading-7 text-ink outline-none placeholder:text-faint"
                value={text}
                maxLength={2000}
                rows={1}
                placeholder="Message Alfred"
                enterKeyHint="send"
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <div className="mt-2 flex items-center justify-between">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => fileRef.current?.click()}
                  aria-label="Attach a screenshot"
                  className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-gold disabled:opacity-40"
                >
                  <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/heic,image/heif"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void uploadImage(file);
                  }}
                />
                <button
                  type="submit"
                  disabled={busy || text.trim().length === 0}
                  aria-label="Send"
                  className="grid size-9 shrink-0 place-items-center rounded-full bg-gold text-gold-ink transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:bg-surface-2 disabled:text-faint"
                >
                  <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 19V5m-6 6 6-6 6 6" />
                  </svg>
                </button>
              </div>
            </div>
            <p className="mt-2 hidden text-center text-xs text-faint sm:block">Enter to send · Shift+Enter for a new line · Alfred can make mistakes, so check anything important.</p>
          </div>
        </form>
      </div>

      <aside className="hidden w-80 shrink-0 overflow-y-auto border-l border-line bg-surface p-5 xl:block" aria-label="This month">
        <StatsPanel ledger={ledger} />
      </aside>

      {statsOpen ? (
        <div className="fixed inset-0 z-40 xl:hidden" role="dialog" aria-modal="true" aria-label="This month">
          <button type="button" aria-label="Close" className="absolute inset-0 bg-black/60" onClick={() => setStatsOpen(false)} />
          <div className="absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-3xl border-t border-line-strong bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <span className="mx-auto h-1 w-10 rounded-full bg-line-strong" aria-hidden="true" />
            </div>
            <StatsPanel ledger={ledger} />
            <button type="button" onClick={() => setStatsOpen(false)} className="mt-5 w-full rounded-full border border-line-strong py-2 text-sm text-muted">
              Close
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TelegramBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[#2aabee]/15 px-2 py-0.5 text-[10px] font-medium text-[#2aabee]">
      <svg viewBox="0 0 24 24" className="size-2.5" fill="currentColor" aria-hidden="true">
        <path d="M21.9 4.3 18.7 19.5c-.2 1-.9 1.3-1.7.8l-4.8-3.5-2.3 2.2c-.3.3-.5.5-1 .5l.3-4.9 8.9-8c.4-.3-.1-.5-.6-.2l-11 6.9-4.7-1.5c-1-.3-1-1 .2-1.5L20.5 3c.9-.3 1.6.2 1.4 1.3z" />
      </svg>
      Telegram
    </span>
  );
}

/** Scales a photo down before upload so it stays well under the server's body limit. */
async function shrinkImage(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
    return blob ?? file;
  } catch {
    // Some browsers can't decode HEIC; the server accepts the original if it's small enough.
    return file;
  }
}

function serverMessage(message: ServerMessage): ThreadMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    channel: message.channel,
    createdAt: message.createdAt,
    clientId: message.clientId,
    status: "sent",
    chart: message.chart ?? null,
  };
}
