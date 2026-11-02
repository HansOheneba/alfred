"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { ReplyChart } from "@/app/chat/reply-chart";
import { StatsPanel } from "@/app/chat/stats-panel";
import { AlfredMark } from "@/app/components/app-shell";
import { getGettingStartedState } from "@/app/components/getting-started-state";
import type { ChatChart } from "@/lib/accounts/messages";
import { mergeThread, threadKey, type ThreadMessage } from "@/lib/accounts/thread";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import type { Ledger } from "@/lib/web/ledger";

import "./chat.css";

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

const FIRST_USE_STARTERS: Suggestion[] = [
  { label: "Record an expense", text: "Spent ", fill: true },
  { label: "Record income", text: "Received ", fill: true },
];

const FOLLOW_UPS: Suggestion[] = [
  { label: "Break it down", text: "Break that down by category" },
  { label: "Compare with last month", text: "How does this compare with last month?" },
  { label: "Tips to spend less", text: "Any tips to spend less?" },
];

const noSubscribe = () => () => {};

export const STATS_EVENT = "alfred:open-stats";

/** Retained for existing controls that open the conversation context sheet. */
export function StatsButton() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(STATS_EVENT))}
      aria-label="This month at a glance"
      className="grid size-11 place-items-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
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
  initialQuestion = "",
}: {
  ownerId: string;
  name: string;
  initialMessages: ThreadMessage[];
  ledger: Ledger;
  initialQuestion?: string;
}) {
  const router = useRouter();
  const [text, setText] = useState(initialQuestion);
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

  // A dashboard question is a draft, never an automatic financial action or POST.
  useEffect(() => {
    if (!initialQuestion) return;
    const node = inputRef.current;
    node?.focus({ preventScroll: true });
    node?.setSelectionRange(initialQuestion.length, initialQuestion.length);
  }, [initialQuestion]);

  // Existing callers can also ask for the context sheet by event.
  useEffect(() => {
    const open = () => setStatsOpen(true);
    window.addEventListener(STATS_EVENT, open);
    return () => window.removeEventListener(STATS_EVENT, open);
  }, []);

  useEffect(() => {
    const node = threadRef.current;
    if (!node) return;
    const alignThread = () => {
      if (stickToBottom.current) node.scrollTop = messages.length > 0 || busy ? node.scrollHeight : 0;
    };
    alignThread();
    const observer = new ResizeObserver(alignThread);
    observer.observe(node);
    return () => observer.disconnect();
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

  const financialsEmpty = getGettingStartedState(ledger).isEmpty;
  const firstUse = messages.length === 0 && financialsEmpty;
  const starters = firstUse ? FIRST_USE_STARTERS : STARTERS;
  const last = messages.at(-1);
  const showFollowUps = !busy && last?.role === "assistant" && !(last.actionId && !last.settled) && text.length === 0;

  return (
    <div className="alfred-production-chat">
      <section className="alfred-production-chat-conversation" aria-label="Chat with Alfred">
        <h1 className="sr-only">Chat</h1>

        <div ref={threadRef} tabIndex={0} className="alfred-production-chat-scroll" aria-busy={busy} onScroll={onThreadScroll}>
          {messages.length === 0 ? (
            <div className="alfred-production-chat-empty" data-first-use={firstUse ? "true" : undefined}>
              <AlfredMark size="size-12 alfred-production-chat-emptyMark" />
              <h2>{firstUse ? (name ? `Welcome, ${name}.` : "Welcome to Alfred.") : hello || "Hello."}</h2>
              <p>{firstUse ? "Start with something you spent or earned. Tell me the amount and what it was for, and we’ll build your overview from there." : <>Tell me what you spend or earn and I&apos;ll keep the books. Ask where your money goes and I&apos;ll tell you honestly. This is the same conversation as Telegram.</>}</p>
              <div className="alfred-production-chat-starters" role="group" aria-label={firstUse ? "Start recording your money" : "Conversation starters"}>{starters.map((suggestion) => <button key={suggestion.label} type="button" disabled={busy} onClick={() => pickSuggestion(suggestion)}>{suggestion.label}<span aria-hidden="true">↗</span></button>)}</div>
              {firstUse ? <><p className="alfred-production-chat-draftHint">Choose a starting point, then add your details before sending.</p><ChatGettingStarted /></> : null}
            </div>
          ) : (
            <div className="alfred-production-chat-thread" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions">
              {messages.map((message, index) => message.role === "assistant" ? (
                <article key={threadKey(message)} className="alfred-production-chat-assistant">
                  <div className="alfred-production-chat-messageIdentity"><AlfredMark size="size-6" /><span>Alfred</span>{message.channel === "telegram" ? <TelegramBadge /> : null}</div>
                  <div className="alfred-production-chat-assistantContent">
                    <p>{message.text}</p>
                    {message.chart ? <ReplyChart chart={message.chart} /> : null}
                    {message.actionId && !message.settled ? <div className="alfred-production-chat-decisions"><button type="button" disabled={busy} className="is-primary" onClick={() => void send({ decision: "confirm", actionId: message.actionId, clientId: `confirm-${message.actionId}` })}>Confirm</button><button type="button" disabled={busy} onClick={() => void send({ decision: "cancel", actionId: message.actionId, clientId: `cancel-${message.actionId}` })}>Cancel</button></div> : null}
                  </div>
                </article>
              ) : (
                <article key={threadKey(message)} className="alfred-production-chat-user" data-sending={message.status === "sending"}>
                  {message.channel === "telegram" ? <TelegramBadge /> : null}
                  <div className="alfred-production-chat-userRow"><div><p>{message.text}</p></div><span className="alfred-production-chat-userAvatar" aria-label={name || "You"}>{name.trim().charAt(0).toUpperCase() || "Y"}</span></div>
                  {canRetry(message, index) ? <button type="button" className="alfred-production-chat-retry" onClick={() => submitText(message.text, message.clientId ?? undefined)}>Not sent · Retry</button> : null}
                </article>
              ))}
            </div>
          )}
          {financialsEmpty && messages.length > 0 ? <ChatGettingStarted inline /> : null}
          {busy ? <div className="alfred-production-chat-thinking" role="status" aria-label="Alfred is thinking"><AlfredMark size="size-7" /><span aria-hidden="true"><i className="alfred-dot" /><i className="alfred-dot" /><i className="alfred-dot" /></span></div> : null}
          {error ? <p className="alfred-production-chat-error" role="alert">{error}</p> : null}
        </div>

        <div className="alfred-production-chat-composeArea">
          {initialQuestion && text === initialQuestion ? <p className="alfred-production-chat-handoff"><ChatIcon><path d="m5 12 4 4L19 6" /></ChatIcon>Question from your dashboard. Review it below, then send when ready.</p> : null}
          {showFollowUps ? <div className="alfred-production-chat-followUps" aria-label="Suggested follow-up questions">{FOLLOW_UPS.map((suggestion) => <button key={suggestion.label} type="button" onClick={() => pickSuggestion(suggestion)}>{suggestion.label}</button>)}</div> : null}
          <form className="alfred-production-chat-composer" onSubmit={(event) => { event.preventDefault(); submitText(text); }}>
            <div className="alfred-production-chat-composerHeader">
              <label htmlFor="alfred-message">Message Alfred</label>
              <div className="alfred-production-chat-tools" role="group" aria-label="Conversation actions">
                {!financialsEmpty ? <button type="button" className="alfred-production-chat-contextToggle" aria-label="Show context" title="Show context" aria-haspopup="dialog" aria-expanded={statsOpen} aria-controls="alfred-production-chat-contextSheet" onClick={() => setStatsOpen(true)}><ChatIcon><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M14 4v16M6 8h4m-4 4h4" /></ChatIcon><span>Context</span></button> : null}
                <button type="button" className="alfred-production-chat-new" aria-label="New message" title="New message — keep saved conversation" disabled={busy} onClick={() => { setText(""); inputRef.current?.focus(); }}><ChatIcon><path d="M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7M16 3l5 5M10 14l2-6 5-5a2.1 2.1 0 0 1 3 3l-5 5-5 3Z" /></ChatIcon><span>New message</span></button>
              </div>
            </div>
            <textarea ref={inputRef} id="alfred-message" value={text} maxLength={2000} rows={2} placeholder="Ask about your spending, budget or accounts…" enterKeyHint="send" onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
            <div className="alfred-production-chat-composerFooter">
              <div><button type="button" disabled={busy} onClick={() => fileRef.current?.click()} aria-label="Attach a screenshot" title="Attach a screenshot"><ChatIcon><path d="M12 5v14M5 12h14" /></ChatIcon></button><span>Enter to send · Shift + Enter for a new line</span></div>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/heic,image/heif" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void uploadImage(file); }} />
              <button type="submit" disabled={busy || text.trim().length === 0} aria-label="Send" className="alfred-production-chat-send"><span>Send</span><ChatIcon><path d="M12 19V5m-6 6 6-6 6 6" /></ChatIcon></button>
            </div>
          </form>
          <p className="alfred-production-chat-disclaimer">Alfred can make mistakes. Check anything important.</p>
        </div>
      </section>

      {!financialsEmpty ? <ContextSheet open={statsOpen} onClose={() => setStatsOpen(false)}><StatsPanel ledger={ledger} /></ContextSheet> : null}
    </div>
  );
}


/** Static setup UI, kept outside the saved conversation log. */
function ChatGettingStarted({ inline = false }: { inline?: boolean }) {
  return <section className={`alfred-production-chat-gettingStarted${inline ? " is-inline" : ""}`} aria-label="Getting started">
    {inline ? <h2>Give Alfred a starting point</h2> : null}
    <p>Your balances and spending will appear as you add accounts and record activity.</p>
    <div className="alfred-production-chat-gettingStartedActions">
      <Link className="alfred-production-chat-setupPrimary" href="/accounts?add=1">Add your first account <span aria-hidden="true">↗</span></Link>
      <Link className="alfred-production-chat-setupLink" href="/dashboard">View your setup checklist <span aria-hidden="true">↗</span></Link>
    </div>
  </section>;
}

function ChatIcon({ children }: { children: ReactNode }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}

function ContextSheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) { previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; node.showModal(); }
    else if (!open && node.open) { node.close(); previousFocus.current?.focus({ preventScroll: true }); }
  }, [open]);
  return <dialog ref={dialog} id="alfred-production-chat-contextSheet" className="alfred-production-chat-contextSheet" aria-labelledby="alfred-production-chat-contextTitle" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={() => { previousFocus.current?.focus({ preventScroll: true }); if (open) onClose(); }} onClick={(event) => {
    if (event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
  }} onKeyDown={(event) => {
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex="0"]')].filter((node) => node.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
  }}><header><div><h2 id="alfred-production-chat-contextTitle">Conversation context</h2><p>Your recorded activity, alongside Chat</p></div><button type="button" aria-label="Close context" onClick={onClose} autoFocus><ChatIcon><path d="m6 6 12 12M6 18 18 6" /></ChatIcon></button></header><div className="alfred-production-chat-contextSheetBody">{children}</div><footer><button type="button" onClick={onClose}>Back to chat <span aria-hidden="true">↗</span></button></footer></dialog>;
}

function TelegramBadge() {
  return (
    <span className="alfred-production-chat-telegram">
      <svg viewBox="0 0 24 24" className="size-3" fill="currentColor" aria-hidden="true">
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
