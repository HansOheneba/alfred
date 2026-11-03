"use client";

import Link from "next/link";
import { buttonClassName } from "@/app/components/button-styles";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { followUpsFor, type Suggestion } from "@/app/chat/follow-ups";
import { CHAT_CONTEXT_ERROR, CHAT_SESSION_CHANGED, invalidateAfterChatOutcome, loadOwnedChatContext } from "@/app/chat/context-data";
import { createChatEmptyStatusRefresh } from "@/app/chat/empty-status";
import { ReplyChart } from "@/app/chat/reply-chart";
import { StatsPanel } from "@/app/chat/stats-panel";
import { AlfredMark } from "@/app/components/app-shell";
import { getGettingStartedState } from "@/app/components/getting-started-state";
import type { ChatChoice } from "@/lib/accounts/chat-choices";
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
  ledgerChanged?: boolean;
};

const QUICK_ACTIONS: (Suggestion & { description: string; tone: "expense" | "income" })[] = [
  { label: "Record an expense", description: "Start with something you spent.", text: "Spent ", fill: true, tone: "expense" },
  { label: "Record income", description: "A payday, a side gig, a little extra.", text: "Received ", fill: true, tone: "income" },
];



export const STATS_EVENT = "alfred:open-stats";

/** Retained for existing controls that open the conversation context sheet. */
export function StatsButton() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(STATS_EVENT))}
      aria-label="This month at a glance"
      className={buttonClassName({ variant: "ghost", size: "icon" })}
    >
      <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <path d="M5 20V11m7 9V5m7 15v-6" />
      </svg>
    </button>
  );
}


export function ChatPanel({
  ownerId,
  name,
  initialMessages,
  initialChoices = [],
  loadInitialChoices = false,
  ledger,
  financialsEmpty: initialFinancialsEmpty = false,
  initialQuestion = "",
}: {
  ownerId: string;
  name: string;
  initialMessages: ThreadMessage[];
  /** Answer buttons already supplied by a caller, with deferred refresh for saved bank questions. */
  initialChoices?: ChatChoice[][];
  loadInitialChoices?: boolean;
  ledger?: Ledger | null;
  /** From the server's cheap empty-account check; the full summary loads only for the context sheet. */
  financialsEmpty?: boolean;
  initialQuestion?: string;
}) {
  const [text, setText] = useState(initialQuestion);
  const [messages, setMessages] = useState<ThreadMessage[]>(initialMessages);
  const [choices, setChoices] = useState<ChatChoice[][]>(initialChoices);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [statsOpen, setStatsOpen] = useState(false);
  const [contextLedger, setContextLedger] = useState<Ledger | null>(ledger ?? null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState("");
  const [contextVersion, setContextVersion] = useState(0);
  // Keep the last confirmed answer during rechecks. null means status is unavailable
  // or the owner changed; it never proves a fresh account.
  const [knownEmpty, setKnownEmpty] = useState<boolean | null>(ledger ? getGettingStartedState(ledger).isEmpty : initialFinancialsEmpty);
  const emptyStatus = useMemo(() => createChatEmptyStatusRefresh(ownerId, setKnownEmpty), [ownerId]);
  const contextDirty = useRef(!ledger);
  const contextRequest = useRef<AbortController | null>(null);
  const contextOwner = useRef(ownerId);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  const stickToBottom = useRef(true);
  const observedAssistant = useRef(initialMessages.filter((message) => message.role === "assistant").at(-1)?.id);
  const refreshQueued = useRef(false);
  const threadRefresh = useRef<ReturnType<typeof createOwnedChatThreadRefresh> | null>(null);

  const loadContext = useCallback(async () => {
    if (!contextDirty.current || contextRequest.current) return;
    const request = new AbortController();
    const requestedOwner = ownerId;
    contextRequest.current = request;
    setContextLoading(true);
    setContextError("");
    try {
      const next = await loadOwnedChatContext(requestedOwner, request.signal);
      if (request.signal.aborted || contextOwner.current !== requestedOwner) return;
      setContextLedger(next);
      setKnownEmpty(getGettingStartedState(next).isEmpty);
      contextDirty.current = false;
    } catch (error) {
      if (!request.signal.aborted) setContextError(error instanceof Error && error.message === CHAT_SESSION_CHANGED ? CHAT_SESSION_CHANGED : CHAT_CONTEXT_ERROR);
    } finally {
      if (contextRequest.current === request) {
        contextRequest.current = null;
        setContextLoading(false);
      }
    }
  }, [ownerId]);

  const invalidateContext = useCallback(() => {
    contextDirty.current = true;
    contextRequest.current?.abort();
    contextRequest.current = null;
    setContextLedger(null);
    setContextLoading(false);
    setContextVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    if (contextOwner.current === ownerId) return;
    contextOwner.current = ownerId;
    invalidateContext();
    setKnownEmpty(null);
    setContextError("");
  }, [ownerId, invalidateContext]);

  useEffect(() => {
    if (!statsOpen) return;
    let active = true;
    // Start after the sheet renders, and ignore a sheet closed before that happens.
    queueMicrotask(() => { if (active) void loadContext(); });
    return () => { active = false; };
  }, [statsOpen, contextVersion, loadContext]);

  // Writes can add or remove the last record; recheck the cheap server rule in either case.
  const afterOutcome = useCallback((ledgerChanged: boolean | undefined) => {
    invalidateAfterChatOutcome(ledgerChanged, invalidateContext);
    void emptyStatus.refresh(ledgerChanged);
  }, [invalidateContext, emptyStatus]);

  const publishThread = useCallback((payload: ThreadRefreshPayload) => {
    setMessages((current) => mergeThread(current, payload.messages.map(serverMessage)));
    setChoices(payload.choices);
    const assistant = payload.messages.filter((message) => message.role === "assistant").at(-1);
    if (assistant && assistant.id !== observedAssistant.current) {
      observedAssistant.current = assistant.id;
      afterOutcome(assistant.ledgerChanged);
    }
  }, [afterOutcome]);
  const refreshThread = useCallback(() => {
    if (sending.current) { refreshQueued.current = true; return; }
    void threadRefresh.current?.refresh();
  }, []);

  useEffect(() => {
    emptyStatus.activate();
    return () => emptyStatus.dispose();
  }, [emptyStatus]);

  useEffect(() => () => { contextRequest.current?.abort(); }, []);

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
            meta?: { chart?: ChatChart; ledgerChanged?: boolean } | null;
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
          if (row.channel === "telegram" && row.role === "assistant") {
            observedAssistant.current = row.id;
            afterOutcome(row.meta?.ledgerChanged);
            setChoices([]);
            refreshThread();
          }
        },
      )
      .subscribe();
    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [ownerId, afterOutcome, refreshThread]);

  useEffect(() => {
    const refresh = createOwnedChatThreadRefresh(ownerId, publishThread);
    threadRefresh.current = refresh;
    if (loadInitialChoices) refreshThread();
    function onVisible() { if (document.visibilityState === "visible") refreshThread(); }
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      refresh.dispose();
      if (threadRefresh.current === refresh) threadRefresh.current = null;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ownerId, publishThread, refreshThread, loadInitialChoices]);

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
    const shownChoices = choices;
    threadRefresh.current?.cancel();
    setChoices([]);
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
        choices?: ChatChoice[][];
        ledgerChanged?: boolean;
      };
      if (!response.ok || !payload.ok) {
        afterOutcome(undefined);
        if (userText && turnId) markFailed(turnId);
        setError(payload.text || "Alfred could not complete that request.");
        setChoices(refreshQueued.current ? [] : shownChoices);
        return;
      }
      setChoices(payload.choices ?? []);
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
      const lastAssistant = incoming.filter((message) => message.role === "assistant").at(-1);
      if (lastAssistant) observedAssistant.current = lastAssistant.id;
      // Only a server-observed write (or an older unknown outcome) invalidates financial context.
      afterOutcome(payload.ledgerChanged);
    } catch {
      afterOutcome(undefined);
      if (userText && turnId) markFailed(turnId);
      setError("Alfred could not reach the server.");
      setChoices(refreshQueued.current ? [] : shownChoices);
    } finally {
      sending.current = false;
      setBusy(false);
      if (refreshQueued.current) { refreshQueued.current = false; refreshThread(); }
    }
  }

  async function uploadImage(file: File) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    threadRefresh.current?.cancel();
    setChoices([]);
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
        ledgerChanged?: boolean;
      };
      if (!response.ok || !payload.ok) {
        afterOutcome(undefined);
        markFailed(turnId);
        setError(payload.text || "Alfred couldn't read that image.");
        return;
      }
      const incoming = (payload.messages ?? []).map((message, index, all) => {
        const view = serverMessage(message);
        return message.role === "assistant" && index === all.length - 1 ? { ...view, actionId: payload.actionId ?? null } : view;
      });
      setMessages((current) => mergeThread(current, incoming));
      afterOutcome(payload.ledgerChanged);
    } catch {
      afterOutcome(undefined);
      markFailed(turnId);
      setError("Alfred could not reach the server.");
    } finally {
      sending.current = false;
      setBusy(false);
      if (refreshQueued.current) { refreshQueued.current = false; refreshThread(); }
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

  const financialsEmpty = contextLedger ? getGettingStartedState(contextLedger).isEmpty : knownEmpty === true;
  const empty = messages.length === 0;
  const last = messages.at(-1);
  const showFollowUps = !busy && last?.role === "assistant" && !(last.actionId && !last.settled) && text.length === 0;

  return (
    <div className="alfred-production-chat">
      <section className="alfred-production-chat-conversation" data-empty={empty} aria-label="Chat with Alfred">
        <h1 className="sr-only">Chat</h1>

        <div ref={threadRef} tabIndex={0} className="alfred-production-chat-scroll" aria-busy={busy} onScroll={onThreadScroll}>
          {!empty ? (
            <div className="alfred-production-chat-thread" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions">
              {messages.map((message, index) => message.role === "assistant" ? (
                <article key={threadKey(message)} className="alfred-production-chat-assistant">
                  <div className="alfred-production-chat-messageIdentity"><AlfredMark size="size-6" /><span>Alfred</span>{message.channel === "telegram" ? <TelegramBadge /> : null}</div>
                  <div className="alfred-production-chat-assistantContent">
                    <p>{message.text}</p>
                    {message.chart ? <ReplyChart chart={message.chart} /> : null}
                    {message.actionId && !message.settled ? <div className="alfred-production-chat-decisions"><button type="button" disabled={busy} className={buttonClassName({ variant: "primary", size: "sm", className: "is-primary" })} onClick={() => void send({ decision: "confirm", actionId: message.actionId, clientId: `confirm-${message.actionId}` })}>Confirm</button><button className={buttonClassName({ variant: "secondary", size: "sm" })} type="button" disabled={busy} onClick={() => void send({ decision: "cancel", actionId: message.actionId, clientId: `cancel-${message.actionId}` })}>Cancel</button></div> : null}
                  </div>
                </article>
              ) : (
                <article key={threadKey(message)} className="alfred-production-chat-user" data-sending={message.status === "sending"}>
                  {message.channel === "telegram" ? <TelegramBadge /> : null}
                  <div className="alfred-production-chat-userRow"><div><p>{message.text}</p></div><span className="alfred-production-chat-userAvatar" aria-label={name || "You"}>{name.trim().charAt(0).toUpperCase() || "Y"}</span></div>
                  {canRetry(message, index) ? <button type="button" className={buttonClassName({ variant: "ghost", size: "sm", className: "alfred-production-chat-retry" })} onClick={() => submitText(message.text, message.clientId ?? undefined)}>Not sent · Retry</button> : null}
                </article>
              ))}
              {busy ? <div className="alfred-production-chat-thinking" role="status" aria-label="Alfred is thinking"><AlfredMark size="size-6" /><span aria-hidden="true"><i className="alfred-dot" /><i className="alfred-dot" /><i className="alfred-dot" /></span></div> : null}
            </div>
          ) : null}
          {financialsEmpty && messages.length > 0 ? <ChatGettingStarted /> : null}
          {error && !empty ? <p className="alfred-production-chat-error" role="alert">{error}</p> : null}
        </div>

        <div className="alfred-production-chat-composeArea">
          {empty ? <header className="alfred-production-chat-welcome">
            <div className="alfred-production-chat-welcomeEmblem"><AlfredMark size="size-16 alfred-production-chat-welcomeMark" /></div>
            <h2>{name.trim() ? <>Hey, <span>{name.trim()}.</span></> : "Hey there."}</h2>
            <p>A purchase, a payday, a plan. Where shall we start?</p>
          </header> : null}
          {empty ? <div className="alfred-production-chat-quickActions" role="group" aria-label="Start recording your money">
            {QUICK_ACTIONS.map((suggestion) => <button key={suggestion.label} type="button" data-tone={suggestion.tone} aria-label={suggestion.label} aria-describedby={`alfred-start-${suggestion.tone}`} disabled={busy} onClick={() => pickSuggestion(suggestion)}>
              <span className="alfred-production-chat-actionIcon"><ChatIcon>{suggestion.tone === "expense" ? <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 7h6m-6 4h4"/></> : <><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M12 8v8m3-5-3-3-3 3"/></>}</ChatIcon></span>
              <span className="alfred-production-chat-actionCopy"><strong>{suggestion.label}</strong><span id={`alfred-start-${suggestion.tone}`}>{suggestion.description}</span></span>
            </button>)}
            <Link href="/accounts?add=1" data-tone="account" aria-label="Add account" aria-describedby="alfred-start-account">
              <span className="alfred-production-chat-actionIcon"><ChatIcon><rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 9h18M16 14h3M7 5V3h11"/></ChatIcon></span>
              <span className="alfred-production-chat-actionCopy"><strong>Add account <span className="alfred-production-chat-actionArrow" aria-hidden="true">↗</span></strong><span id="alfred-start-account">Bring your balances into the picture.</span></span>
            </Link>
          </div> : null}
          {initialQuestion && text === initialQuestion ? <p className="alfred-production-chat-handoff"><ChatIcon><path d="m5 12 4 4L19 6" /></ChatIcon>Question from your dashboard. Review it below, then send when ready.</p> : null}
          {showFollowUps && choices.length ? <div className="alfred-production-chat-choices" role="group" aria-label="Answer Alfred's question">{choices.map((row, index) => <div key={index}>{row.map((item) => item.href ? <Link key={item.label} href={item.href} className={buttonClassName({ variant: "ghost", size: "sm" })}>{item.label}</Link> : <button key={item.choice} type="button" className={buttonClassName({ variant: "secondary", size: "sm" })} onClick={() => void send({ choice: item.choice }, item.label)}>{item.label}</button>)}</div>)}</div> : null}
          {showFollowUps && !choices.length ? <div className="alfred-production-chat-followUps" aria-label="Suggested follow-up questions">{followUpsFor(last).map((suggestion) => <button className={buttonClassName({ variant: "secondary", size: "sm" })} key={suggestion.label} type="button" onClick={() => pickSuggestion(suggestion)}>{suggestion.label}</button>)}</div> : null}
          <form key="alfred-composer" className="alfred-production-chat-composer" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); submitText(text); }}>
            <label className="sr-only" htmlFor="alfred-message">Message Alfred</label>
            <div className="alfred-production-chat-composerRow">
              <button className={buttonClassName({ variant: "ghost", size: "icon" })} type="button" disabled={busy} onClick={() => fileRef.current?.click()} aria-label="Attach a screenshot" title="Attach a screenshot"><ChatIcon><path d="M12 5v14M5 12h14" /></ChatIcon></button>
              <textarea ref={inputRef} id="alfred-message" value={text} maxLength={2000} rows={2} placeholder="Tell me what happened…" aria-describedby="alfred-compose-hint" enterKeyHint="send" onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
              {!financialsEmpty ? <button type="button" className={buttonClassName({ variant: "ghost", size: "icon", className: "alfred-production-chat-contextToggle" })} aria-label="Show context" title="Show context" aria-haspopup="dialog" aria-expanded={statsOpen} aria-controls="alfred-production-chat-contextSheet" onClick={() => setStatsOpen(true)}><ChatIcon><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M14 4v16M6 8h4m-4 4h4" /></ChatIcon><span className="sr-only">Context</span></button> : null}
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/heic,image/heif" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void uploadImage(file); }} />
              <button type="submit" disabled={busy || text.trim().length === 0} aria-label="Send" className={buttonClassName({ variant: "primary", size: "icon", className: "alfred-production-chat-send" })}><span className="sr-only">Send</span><ChatIcon><path d="M12 19V5m-6 6 6-6 6 6" /></ChatIcon></button>
            </div>
            <span id="alfred-compose-hint" className="sr-only">Enter to send · Shift + Enter for a new line</span>
          </form>
          {error && empty ? <p className="alfred-production-chat-error" role="alert">{error}</p> : null}
          {!empty ? <p className="alfred-production-chat-disclaimer">Alfred can make mistakes. Check anything important.</p> : null}
        </div>
      </section>

      <ContextSheet open={statsOpen} onClose={() => setStatsOpen(false)}>
        {contextLedger ? <StatsPanel ledger={contextLedger} /> : contextError ? <div role="alert"><p>{contextError}</p><button type="button" className={buttonClassName({ variant: "secondary", size: "sm" })} onClick={() => void loadContext()}>Try again</button></div> : <p role="status" aria-busy={contextLoading}>Loading your financial summary…</p>}
      </ContextSheet>
    </div>
  );
}


/** Static setup UI, kept outside the saved conversation log. */
function ChatGettingStarted() {
  return <section className="alfred-production-chat-gettingStarted" aria-label="Getting started"><p>Start with an expense or income, or <Link href="/accounts?add=1">add an account <span aria-hidden="true">↗</span></Link>.</p></section>;
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
  }}><header><div><h2 id="alfred-production-chat-contextTitle">Conversation context</h2><p>Your recorded activity, alongside Chat</p></div><button className={buttonClassName({ variant: "secondary", size: "icon" })} type="button" aria-label="Close context" onClick={onClose} autoFocus><ChatIcon><path d="m6 6 12 12M6 18 18 6" /></ChatIcon></button></header><div className="alfred-production-chat-contextSheetBody">{children}</div><footer><button className={buttonClassName({ variant: "ghost", size: "sm" })} type="button" onClick={onClose}>Back to chat <span aria-hidden="true">↗</span></button></footer></dialog>;
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

type ThreadRefreshPayload = { messages: ServerMessage[]; choices: ChatChoice[][] };

/** Component-local fresh reads; late requests and other owners never publish history or answers. */
export function createOwnedChatThreadRefresh(ownerId: string, publish: (payload: ThreadRefreshPayload) => void, request: typeof fetch = fetch) {
  let active = true;
  let sequence = 0;
  let current: AbortController | null = null;
  const cancel = () => { sequence += 1; current?.abort(); current = null; };
  return {
    activate() { active = true; },
    cancel,
    dispose() { active = false; cancel(); },
    async refresh() {
      if (!active) return;
      cancel();
      const version = sequence, controller = new AbortController();
      current = controller;
      try {
        const response = await request("/api/chat", { cache: "no-store", credentials: "same-origin", signal: controller.signal });
        const payload = await response.json() as { ok?: boolean; ownerId?: string; messages?: ServerMessage[]; choices?: ChatChoice[][] };
        if (!active || controller.signal.aborted || sequence !== version || !response.ok || payload.ok !== true || payload.ownerId !== ownerId || !Array.isArray(payload.messages)) return;
        publish({ messages: payload.messages, choices: payload.choices ?? [] });
      } catch { /* Keep the saved thread; a future visibility/realtime event can retry. */ }
      finally { if (current === controller) current = null; }
    },
  };
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
