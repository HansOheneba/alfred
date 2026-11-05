"use client";

import Link from "next/link";
import { buttonClassName } from "@/app/components/button-styles";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { followUpsFor, type Suggestion } from "@/app/chat/follow-ups";
import { ChatContextSkeleton, ChatHistorySkeleton } from "@/app/chat/chat-loading";
import { useChatDraft, useChatDraftFocus } from "@/app/chat/chat-draft";
import { useChatContextController } from "@/app/chat/chat-context-control";
import { CHAT_CONTEXT_ERROR, CHAT_SESSION_CHANGED, invalidateAfterChatOutcome, loadOwnedChatContext } from "@/app/chat/context-data";
import { createChatEmptyStatusRefresh } from "@/app/chat/empty-status";
import type { PaymentChatEntry } from "@/app/chat/payment-entry";
import { capturePaymentChatEntry, chatSubmissionReady, linkedPaymentReplyContext, paymentLinkId } from "@/app/chat/payment-link";
import { chatReadDeadline } from "@/app/chat/read-deadline";
import { ReplyChart } from "@/app/chat/reply-chart";
import { StatsPanel } from "@/app/chat/stats-panel";
import { AlfredMark } from "@/app/components/app-shell";
import { getGettingStartedState } from "@/app/components/getting-started-state";
import type { ChatChoice } from "@/lib/accounts/chat-choices";
import type { ChatChart, ChatMessageRecord } from "@/lib/accounts/messages";
import { mergeThread, paymentReplyContext, threadKey, toThreadMessage, type ThreadMessage } from "@/lib/accounts/thread";
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
  paymentNotice?: ChatMessageRecord["paymentNotice"];
  newTopic?: boolean;
};

const QUICK_ACTIONS: (Suggestion & { description: string; tone: "expense" | "income" })[] = [
  { label: "Record an expense", description: "Start with something you spent.", text: "Spent ", fill: true, tone: "expense" },
  { label: "Record income", description: "A payday, a side gig, a little extra.", text: "Received ", fill: true, tone: "income" },
];



/** Size the draft without measuring an empty, not-yet-laid-out input. */
export function resizeChatComposer(node: { value: string; scrollHeight: number; style: Pick<CSSStyleDeclaration, "height"> }) {
  if (!node.value) {
    node.style.height = "";
    return;
  }
  node.style.height = "auto";
  node.style.height = `${Math.max(44, Math.min(node.scrollHeight, 160))}px`;
}

export function ChatPanel({
  ownerId,
  name,
  initialMessages,
  initialChoices = [],
  loadInitialChoices = false,
  loadInitialThread = false,
  ledger,
  financialsEmpty: initialFinancialsEmpty = false,
  initialQuestion = "",
  initialPaymentEntry = null,
  initialPaymentTarget = null,
  draftScope,
  requestData = fetch,
}: {
  ownerId: string;
  name: string;
  initialMessages: ThreadMessage[];
  /** Answer buttons already supplied by a caller, with deferred refresh for saved bank questions. */
  initialChoices?: ChatChoice[][];
  loadInitialChoices?: boolean;
  /** Authenticated shell is ready; source, history and optional answers load independently. */
  loadInitialThread?: boolean;
  ledger?: Ledger | null;
  /** From the server's cheap empty-account check; the full summary loads only for the context sheet. */
  financialsEmpty?: boolean | null;
  initialQuestion?: string;
  initialPaymentEntry?: PaymentChatEntry | null;
  initialPaymentTarget?: string | null;
  /** Identifies the current question/notification handoff without persisting a draft. */
  draftScope?: string;
  /** Explicit transport seam for the guarded, fictional local preview. */
  requestData?: typeof fetch;
}) {
  const [text, setText] = useChatDraft(initialQuestion, ownerId, draftScope);
  const { restore: restoreDraftFocus } = useChatDraftFocus(draftScope);
  const [messages, setMessages] = useState<ThreadMessage[]>(initialMessages);
  const [choices, setChoices] = useState<ChatChoice[][]>(initialChoices);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [newTopic, setNewTopic] = useState(false);
  const [paymentEntry, setPaymentEntry] = useState(initialPaymentEntry);
  const paymentEntryCurrent = useRef(initialPaymentEntry);
  const deferredHistory = useRef<ThreadMessage[]>([]);
  const publishPaymentEntry = useCallback((entry: PaymentChatEntry | null) => { paymentEntryCurrent.current = entry; setPaymentEntry(entry); }, []);
  const [activePaymentTarget, setActivePaymentTarget] = useState(paymentLinkId(initialPaymentTarget));
  const [historyLoaded, setHistoryLoaded] = useState(!loadInitialThread);
  const [sessionChanged, setSessionChanged] = useState(false);
  const historyLoadedCurrent = useRef(!loadInitialThread);
  const [readProgress, setReadProgress] = useState<Partial<Record<ChatReadProgress["part"], ChatReadProgress>>>({
    history: { part: "history", state: loadInitialThread ? "loading" : "ready" },
    payment: { part: "payment", state: initialPaymentEntry?.state === "unavailable" ? "error" : initialPaymentTarget && initialPaymentEntry?.state !== "ready" ? "loading" : "ready" },
  });
  const checkedInitialEmpty = useRef(initialFinancialsEmpty !== null);
  const [contextLedger, setContextLedger] = useState<Ledger | null>(ledger ?? null);
  const [contextError, setContextError] = useState("");
  const [contextVersion, setContextVersion] = useState(0);
  // Keep the last confirmed answer during rechecks. null means status is unavailable
  // or the owner changed; it never proves a fresh account.
  const [knownEmpty, setKnownEmpty] = useState<boolean | null>(ledger ? getGettingStartedState(ledger).isEmpty : initialFinancialsEmpty);
  const financialsEmpty = contextLedger ? getGettingStartedState(contextLedger).isEmpty : knownEmpty === true;
  const [statsOpen, setStatsOpen] = useChatContextController(!financialsEmpty && !sessionChanged);
  const emptyStatus = useMemo(() => createChatEmptyStatusRefresh(ownerId, setKnownEmpty, requestData), [ownerId, requestData]);
  const contextDirty = useRef(!ledger);
  const contextRequest = useRef<AbortController | null>(null);
  const contextOwner = useRef(ownerId);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  const stickToBottom = useRef(!initialPaymentTarget);
  const selectedPaymentArticle = useRef<HTMLElement>(null);
  const paymentEntryScrolled = useRef(false);
  const observedAssistant = useRef(initialMessages.filter((message) => message.role === "assistant").at(-1)?.id);
  const refreshQueued = useRef(false);
  const threadRefresh = useRef<ReturnType<typeof createOwnedChatThreadRefresh> | null>(null);

  const loadContext = useCallback(async () => {
    if (!contextDirty.current || contextRequest.current) return;
    const request = new AbortController();
    const requestedOwner = ownerId;
    contextRequest.current = request;
    setContextError("");
    try {
      const next = await loadOwnedChatContext(requestedOwner, request.signal, requestData);
      if (request.signal.aborted || contextOwner.current !== requestedOwner) return;
      setContextLedger(next);
      setKnownEmpty(getGettingStartedState(next).isEmpty);
      contextDirty.current = false;
    } catch (error) {
      if (!request.signal.aborted) setContextError(error instanceof Error && error.message === CHAT_SESSION_CHANGED ? CHAT_SESSION_CHANGED : CHAT_CONTEXT_ERROR);
    } finally {
      if (contextRequest.current === request) {
        contextRequest.current = null;
      }
    }
  }, [ownerId, requestData]);

  const invalidateContext = useCallback(() => {
    contextDirty.current = true;
    contextRequest.current?.abort();
    contextRequest.current = null;
    setContextLedger(null);
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
    if (payload.paymentEntry !== undefined) publishPaymentEntry(payload.paymentEntry);
    setMessages((current) => {
      const incoming = payload.messages.map(serverMessage);
      if (payload.part === "history") deferredHistory.current = incoming;
      const next = mergeThread(current, incoming);
      // A later history packet must not replace the selected source's current
      // acknowledgement with an older saved purpose question.
      return paymentEntryCurrent.current?.state === "ready" ? mergeThread(mergeThread(next, deferredHistory.current), [toThreadMessage(paymentEntryCurrent.current.message)]) : activePaymentTarget ? next.filter(message => !(message.role === "assistant" && message.paymentNotice?.bankMessageId === activePaymentTarget && message.clientId?.startsWith("bank_notice_"))) : next;
    });
    if (payload.choices !== undefined) setChoices(payload.choices);
    const assistant = payload.messages.filter((message) => message.role === "assistant").at(-1);
    if (assistant && assistant.id !== observedAssistant.current) {
      observedAssistant.current = assistant.id;
      afterOutcome(assistant.ledgerChanged);
    }
  }, [afterOutcome, publishPaymentEntry, activePaymentTarget]);
  const onReadProgress = useCallback((progress: ChatReadProgress) => {
    if (progress.sessionChanged) {
      setText("");
      setSessionChanged(true); setMessages([]); deferredHistory.current = []; publishPaymentEntry({ state: "unavailable" });
      setChoices([]); setHistoryLoaded(false); historyLoadedCurrent.current = false; setKnownEmpty(null); invalidateContext();
    }
    setReadProgress(current => ({ ...current, [progress.part]: progress }));
    if (progress.state === "loading" && (progress.part === "payment" || progress.part === "choices") || progress.state === "error" && progress.part === "choices") setChoices([]);
    if (progress.part === "payment" && progress.state === "error") publishPaymentEntry({ state: "unavailable" });
    if ((progress.part === "history" || progress.part === "thread") && progress.state === "ready") {
      setHistoryLoaded(true);
      historyLoadedCurrent.current = true;
      if (!checkedInitialEmpty.current && !initialPaymentTarget) { checkedInitialEmpty.current = true; void emptyStatus.refresh(true); }
    }
  }, [publishPaymentEntry, initialPaymentTarget, emptyStatus, invalidateContext, setText]);
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
    const node = inputRef.current;
    if (!node || restoreDraftFocus(node) || !initialQuestion) return;
    node.focus({ preventScroll: true });
    node.setSelectionRange(node.value.length, node.value.length);
  }, [initialQuestion, restoreDraftFocus]);

  useEffect(() => {
    if (paymentEntry?.state !== "ready" || !activePaymentTarget || paymentEntryScrolled.current) return;
    const node = selectedPaymentArticle.current;
    if (!node) return;
    paymentEntryScrolled.current = true;
    stickToBottom.current = false;
    node.scrollIntoView({ block: "center" });
    node.focus({ preventScroll: true });
  }, [paymentEntry, activePaymentTarget, messages]);

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
    resizeChatComposer(node);
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
            intent?: string | null;
            meta?: { chart?: ChatChart; ledgerChanged?: boolean; paymentNotice?: ChatMessageRecord["paymentNotice"];newTopic?:boolean } | null;
          };
          if (!active || row.owner_id !== ownerId || !row.id || (row.role !== "user" && row.role !== "assistant")) return;
          if (row.channel !== "web" && row.channel !== "telegram") return;
          // The selected alert is rendered from current owned source evidence,
          // not a possibly stale notice body racing its push delivery.
          if (activePaymentTarget && row.role === "assistant" && row.intent?.startsWith("automation:") && row.meta?.paymentNotice?.bankMessageId === activePaymentTarget) {
            refreshThread();
            return;
          }
          const incoming: ThreadMessage = {
            id: row.id,
            role: row.role,
            text: row.body ?? "",
            channel: row.channel,
            createdAt: row.created_at ?? new Date(0).toISOString(),
            clientId: row.client_id ?? null,
            status: "sent",
            chart: row.meta?.chart ?? null,
            paymentNotice: row.meta?.paymentNotice,
            newTopic: row.meta?.newTopic,
          };
          setMessages((current) => mergeThread(current, [incoming]));
          if (row.role === "assistant" && (row.channel === "telegram" || row.intent?.startsWith("automation:"))) {
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
  }, [ownerId, afterOutcome, refreshThread, activePaymentTarget]);

  useEffect(() => {
    const refresh = createOwnedChatThreadRefresh(ownerId, publishThread, requestData, activePaymentTarget, { progressive: true, onProgress: onReadProgress });
    threadRefresh.current = refresh;
    if (loadInitialChoices || loadInitialThread) refreshThread();
    function onVisible() { if (document.visibilityState === "visible") refreshThread(); }
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      refresh.dispose();
      if (threadRefresh.current === refresh) threadRefresh.current = null;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ownerId, publishThread, refreshThread, loadInitialChoices, loadInitialThread, activePaymentTarget, requestData, onReadProgress]);

  function onThreadScroll() {
    const node = threadRef.current;
    if (!node) return;
    stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 96;
  }

  async function send(body: Record<string, unknown>, userText?: string, clientId?: string) {
    if (sending.current || sessionChanged) return;
    if (!chatSubmissionReady(activePaymentTarget, paymentEntry, historyLoaded, newTopic && typeof body.text === "string")) return;
    let completed = false;
    let sessionRejected = false;
    sending.current = true;
    setBusy(true);
    setError("");
    const shownChoices = choices;
    threadRefresh.current?.cancel();
    setChoices([]);
    const bodyClientId = typeof body.clientId === "string" ? body.clientId : undefined;
    const turnId = clientId ?? bodyClientId ?? (userText ? crypto.randomUUID() : undefined);
    const original = turnId ? messages.find((message) => message.role === "user" && message.clientId === turnId) : undefined;
    const startsNewTopic = typeof body.text === "string" && (original ? Boolean(original.newTopic) : newTopic);
    const replyToPayment = (typeof body.text === "string" || typeof body.choice === "string")
      ? startsNewTopic ? undefined : linkedPaymentReplyContext(messages, turnId, paymentEntry ? paymentEntry.state === "ready" ? paymentEntry.message.paymentNotice : null : undefined)
      : undefined;
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
            paymentNotice: replyToPayment ?? undefined,
            newTopic: startsNewTopic || undefined,
          },
        ]);
      });
      setText((current) => (current.trim() === userText ? "" : current));
      setNewTopic(false);
      stickToBottom.current = true;
    }
    try {
      const response = await requestData("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, clientId: turnId, ...(paymentLinkId(ownerId) ? { expectedOwnerId: paymentLinkId(ownerId) } : {}), ...((typeof body.text === "string" || typeof body.choice === "string") ? { replyToPayment: replyToPayment ?? null } : {}), ...(startsNewTopic ? { newTopic: true } : {}) }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        text?: string;
        actionId?: string | null;
        messages?: ServerMessage[];
        choices?: ChatChoice[][];
        ledgerChanged?: boolean;
        sessionChanged?: boolean;
      };
      if (payload.sessionChanged) {
        sessionRejected = true;
        onReadProgress({ part: "thread", state: "error", sessionChanged: true, text: "Your session changed. Reload this page to continue." });
        return;
      }
      if (!response.ok || !payload.ok) {
        afterOutcome(undefined);
        if (userText && turnId) markFailed(turnId);
        setError(payload.text || "Alfred could not complete that request.");
        setChoices(refreshQueued.current ? [] : shownChoices);
        return;
      }
      setChoices(payload.choices ?? []);
      // The saved reply now carries the binding; future ordinary conversation
      // follows that response rather than reselecting the notification forever.
      publishPaymentEntry(null);
      setActivePaymentTarget(null);
      setHistoryLoaded(true);
      historyLoadedCurrent.current = true;
      completed = true;
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
      if (sessionRejected || completed && activePaymentTarget) refreshQueued.current = false;
      else if (refreshQueued.current || loadInitialThread && !historyLoadedCurrent.current) { refreshQueued.current = false; refreshThread(); }
    }
  }

  async function uploadImage(file: File) {
    if (sending.current || sessionChanged) return;
    if (!newTopic && activePaymentTarget && paymentEntry?.state !== "ready" || !activePaymentTarget && !historyLoaded) return;
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
      const response = await requestData("/api/chat/image", { method: "POST", body: form });
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

  // Until the owned history read finishes, only a freshly verified selected
  // payment and an explicitly sent local turn are safe to show as conversation.
  const visibleMessages = historyLoaded ? messages : messages.filter(message => isSelectedPaymentMessage(message, paymentEntry) || message.role === "user" && (message.status === "sending" || message.status === "failed"));
  const empty = visibleMessages.length === 0;
  const showWelcome = empty && historyLoaded && !activePaymentTarget;
  const historyLoading = !historyLoaded && !sessionChanged && readProgress.history?.state !== "error";
  const sourceReady = paymentEntry?.state === "ready" && paymentEntry.bankMessageId === activePaymentTarget;
  const sendingAllowed = !sessionChanged && chatSubmissionReady(activePaymentTarget, paymentEntry, historyLoaded, newTopic);
  const last = visibleMessages.at(-1);
  const shownPaymentContext = paymentEntry?.state === "ready" ? paymentEntry.message.paymentNotice : paymentReplyContext(visibleMessages);
  const showFollowUps = historyLoaded && !busy && last?.role === "assistant" && !(last.actionId && !last.settled) && text.length === 0;

  return (
    <div className="alfred-production-chat">
      <section className="alfred-production-chat-conversation" data-empty={showWelcome} aria-label="Chat with Alfred">
        <h1 className="sr-only">Chat</h1>
        {sessionChanged ? <div className="mx-6 mt-3 text-sm text-danger" role="alert"><p>Your session changed. Reload this page to continue.</p><a className="alfred-chat-answer-chip mt-2" href={activePaymentTarget ? `/chat?payment=${activePaymentTarget}` : "/chat"}>Reload</a></div> : null}

        {activePaymentTarget && !sourceReady ? <div className="mx-6 mt-3 text-sm text-muted" role="status" aria-busy={readProgress.payment?.state === "loading"}><p>{readProgress.payment?.state === "loading" ? "Opening this payment…" : "I couldn't open this payment. Try again, or ask me about something else."}</p>{newTopic ? <p className="mt-1">Your next message is about something else. This alert hasn&apos;t been changed.</p> : null}<div className="mt-2 flex flex-wrap gap-2">{readProgress.payment?.state !== "loading" ? <button type="button" className="alfred-chat-answer-chip" onClick={refreshThread}>Try again</button> : null}<button type="button" className="alfred-chat-answer-chip" onClick={() => { setNewTopic(!newTopic); inputRef.current?.focus(); }}>{newTopic ? "Back to this payment" : "Ask something else"}</button></div></div> : paymentEntry?.state === "unavailable" ? <p className="mx-6 mt-3 text-sm text-muted" role="status">I couldn&apos;t open that payment alert. Your conversation is still here.</p> : null}
        {readProgress.choices?.state === "error" ? <div className="mx-6 mt-3 text-sm text-muted" role="status"><p>The answer choices couldn&apos;t load. You can type your reply or try again.</p><button type="button" className="alfred-chat-answer-chip mt-2" onClick={refreshThread}>Try again</button></div> : null}

        <div ref={threadRef} tabIndex={0} className="alfred-production-chat-scroll" aria-busy={busy || historyLoading} onScroll={onThreadScroll}>
          {!historyLoaded && !sessionChanged && readProgress.history?.state === "error" ? <div className="alfred-production-chat-historyError" role="status"><p>Your conversation couldn&apos;t load. Please try again.</p><button type="button" className="alfred-chat-answer-chip mt-2" onClick={refreshThread}>Try again</button></div> : null}
          {!empty ? (
            <div className="alfred-production-chat-thread" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions">
              {visibleMessages.map((message, index) => message.role === "assistant" ? (
                <article key={threadKey(message)} ref={isSelectedPaymentMessage(message, paymentEntry) ? selectedPaymentArticle : undefined} tabIndex={isSelectedPaymentMessage(message, paymentEntry) ? -1 : undefined} data-payment-selected={isSelectedPaymentMessage(message, paymentEntry) || undefined} className="alfred-production-chat-assistant">
                  <div className="alfred-production-chat-messageIdentity"><AlfredMark size="size-6" /><span>Alfred</span>{message.channel === "telegram" ? <TelegramBadge /> : null}</div>
                  <div className="alfred-production-chat-assistantContent">
                    <p>{message.text}</p>
                    {message.chart ? <ReplyChart chart={message.chart} /> : null}
                    {(paymentEntry?.state === "ready" ? isSelectedPaymentMessage(message, paymentEntry) : message === last) && !newTopic && !busy && choices.length ? <AnswerChoices choices={choices} onChoose={(item) => void send({ choice: item.choice }, item.label)} /> : null}
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
          {historyLoading ? <ChatHistorySkeleton /> : null}
          {financialsEmpty && historyLoaded && !empty ? <ChatGettingStarted /> : null}
          {error && !empty ? <p className="alfred-production-chat-error" role="alert">{error}</p> : null}
        </div>

        <div className="alfred-production-chat-composeArea">
          {showWelcome ? <header className="alfred-production-chat-welcome">
            <div className="alfred-production-chat-welcomeEmblem"><AlfredMark size="size-16 alfred-production-chat-welcomeMark" /></div>
            <h2>{name.trim() ? <>Hey, <span>{name.trim()}.</span></> : "Hey there."}</h2>
            <p>A purchase, a payday, a plan. Where shall we start?</p>
          </header> : null}
          {showWelcome ? <div className="alfred-production-chat-quickActions" role="group" aria-label="Start recording your money">
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
          {shownPaymentContext ? <PaymentReplyContext newTopic={newTopic} pending={shownPaymentContext.requiresPurpose} busy={busy} onChange={() => { if (!newTopic) { const captured = capturePaymentChatEntry(messages, paymentEntry); if (captured?.state === "ready") { publishPaymentEntry(captured); setActivePaymentTarget(captured.bankMessageId); } } setNewTopic(!newTopic); setChoices([]); if (newTopic) refreshThread(); inputRef.current?.focus(); }} /> : null}
          {showFollowUps && !choices.length ? <div className="alfred-production-chat-followUps" aria-label="Suggested follow-up questions">{followUpsFor(last).map((suggestion) => <button className={buttonClassName({ variant: "secondary", size: "sm" })} key={suggestion.label} type="button" onClick={() => pickSuggestion(suggestion)}>{suggestion.label}</button>)}</div> : null}
          <form key="alfred-composer" className="alfred-production-chat-composer" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); submitText(text); }}>
            <label className="sr-only" htmlFor="alfred-message">Message Alfred</label>
            <div className="alfred-production-chat-composerRow">
              <button className={buttonClassName({ variant: "ghost", size: "icon" })} type="button" disabled={busy || !sendingAllowed} onClick={() => fileRef.current?.click()} aria-label="Attach a screenshot" title="Attach a screenshot"><ChatIcon><path d="M12 5v14M5 12h14" /></ChatIcon></button>
              <textarea ref={inputRef} id="alfred-message" value={text} maxLength={2000} rows={1} placeholder="Tell me what happened…" aria-describedby="alfred-compose-hint" enterKeyHint="send" onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/heic,image/heif" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void uploadImage(file); }} />
              <button type="submit" disabled={busy || !sendingAllowed || text.trim().length === 0} aria-label="Send" className={buttonClassName({ variant: "primary", size: "icon", className: "alfred-production-chat-send" })}><span className="sr-only">Send</span><ChatIcon><path d="M12 19V5m-6 6 6-6 6 6" /></ChatIcon></button>
            </div>
            <span id="alfred-compose-hint" className="sr-only">Enter to send · Shift + Enter for a new line</span>
          </form>
          {error && empty ? <p className="alfred-production-chat-error" role="alert">{error}</p> : null}
          {!empty ? <p className="alfred-production-chat-disclaimer">Alfred can make mistakes. Check anything important.</p> : null}
        </div>
      </section>

      <ContextSheet open={statsOpen} onClose={() => setStatsOpen(false)}>
        {contextLedger ? <StatsPanel ledger={contextLedger} /> : contextError ? <div role="alert"><p>{contextError}</p><button type="button" className={buttonClassName({ variant: "secondary", size: "sm" })} onClick={() => void loadContext()}>Try again</button></div> : <ChatContextSkeleton />}
      </ContextSheet>
    </div>
  );
}


/** An emphasis only; every answer and navigation action uses the same chip. */
function isSelectedPaymentMessage(message: ThreadMessage, entry: PaymentChatEntry | null): boolean {
  return entry?.state === "ready" && (message.id === entry.message.id || Boolean(message.clientId && message.clientId === entry.message.clientId));
}

function suggestedChoice(item: ChatChoice): boolean {
  return item.choice !== undefined && (/:[rp]$/.test(item.choice) || item.label.startsWith("Yes") || item.label.startsWith("My own"));
}

/** Tap-to-answer chips under Alfred's question about a bank payment. */
function AnswerChoices({ choices, onChoose }: { choices: ChatChoice[][]; onChoose: (item: Extract<ChatChoice, { choice: string }>) => void }) {
  const items = choices.flat();
  return (
    <div className="alfred-chat-answers" role="group" aria-label="Answer Alfred's question">
      <div className="alfred-chat-answers-chips">
        {items.map((item, index) => item.href !== undefined
          ? <Link key={`${item.href}:${index}`} className="alfred-chat-answer-chip" href={item.href}>{item.label} <span aria-hidden="true">↗</span></Link>
          : <button key={`${item.choice}:${index}`} className="alfred-chat-answer-chip" type="button" data-kind={suggestedChoice(item) ? "suggested" : undefined} onClick={() => onChoose(item)}>{item.label}</button>)}
      </div>
    </div>
  );
}

/** A conversation boundary, never a classification or a way to discard an alert. */
export function PaymentReplyContext({ newTopic, pending, busy, onChange }: { newTopic: boolean; pending: boolean; busy: boolean; onChange: () => void }) {
  return <div className="mb-2 flex flex-wrap items-center gap-2 px-2 text-xs text-muted" aria-label="Payment reply context">
    <span role="status">{newTopic ? pending ? "This payment stays pending while we talk about something else." : "Your next message is about something else." : "Replying about this payment alert."}</span>
    <button type="button" disabled={busy} className="alfred-chat-answer-chip" onClick={onChange}>{newTopic ? "Back to this payment" : "Ask something else"}</button>
  </div>;
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
  useEffect(() => {
    if (!open) return;
    const node = dialog.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      if (node?.open) node.close();
      previousFocus.current?.focus({ preventScroll: true });
    };
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

type ThreadRefreshPayload = { messages: ServerMessage[]; choices?: ChatChoice[][]; paymentEntry?: PaymentChatEntry | null; part?: ChatReadProgress["part"] };
export type ChatReadProgress = { part: "payment" | "history" | "choices" | "thread"; state: "loading" | "ready" | "error"; text?: string; sessionChanged?: boolean };

/** Component-local fresh reads; late requests and other owners never publish history or answers. */
export function createOwnedChatThreadRefresh(ownerId: string, publish: (payload: ThreadRefreshPayload) => void, request: typeof fetch = fetch, paymentTarget?: string | null, options: { progressive?: boolean; onProgress?: (progress: ChatReadProgress) => void; timeoutMs?: number } = {}) {
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
      const target = paymentLinkId(paymentTarget);
      const valid = () => active && !controller.signal.aborted && sequence === version;
      let sourceVersion: string | undefined;
      const read = async (part: ChatReadProgress["part"]): Promise<boolean> => {
        const child = new AbortController(), abort = () => child.abort();
        controller.signal.addEventListener("abort", abort, { once: true });
        if (valid()) options.onProgress?.({ part, state: "loading" });
        try {
          const parameters = new URLSearchParams();
          if (target && part !== "history") parameters.set("payment", target);
          if (part !== "thread") parameters.set("part", part);
          const url = `/api/chat${parameters.size ? `?${parameters}` : ""}`;
          const result = await chatReadDeadline((async () => {
            const response = await request(url, { cache: "no-store", credentials: "same-origin", signal: child.signal });
            return { response, payload: await response.json() as { ok?: boolean; ownerId?: string; messages?: ServerMessage[]; choices?: ChatChoice[][]; paymentEntry?: PaymentChatEntry | null; choiceTarget?: string | null; sourceVersion?: string | null; choicesUnavailable?: boolean } };
          })(), options.timeoutMs ?? 10_000, controller.signal, () => child.abort());
          if (!valid()) return false;
          const { response, payload } = result;
          if (payload.ownerId && payload.ownerId !== ownerId) {
            options.onProgress?.({ part, state: "error", text: "Your session changed. Reload this page to continue.", sessionChanged: true });
            controller.abort();
            return false;
          }
          if (!response.ok || payload.ok !== true || payload.ownerId !== ownerId || !Array.isArray(payload.messages)) throw new Error("The conversation could not be read.");
          if (payload.paymentEntry?.state === "ready" && payload.paymentEntry.bankMessageId !== target) throw new Error("The payment changed.");
          if (part === "payment") {
            if (payload.paymentEntry?.state !== "ready") {
              publish({ messages: [], paymentEntry: { state: "unavailable" } });
              throw new Error("The payment is unavailable.");
            }
            sourceVersion = payload.paymentEntry.sourceVersion;
          }
          if (part === "choices" && (payload.choicesUnavailable || target && (payload.choiceTarget !== target || sourceVersion !== undefined && payload.sourceVersion !== sourceVersion))) throw new Error("The payment choices changed.");
          publish({ messages: payload.messages, ...(part === "thread" ? { choices: payload.choices ?? [] } : payload.choices !== undefined ? { choices: payload.choices } : {}), ...(payload.paymentEntry !== undefined ? { paymentEntry: payload.paymentEntry } : {}), ...(options.progressive ? { part } : {}) });
          options.onProgress?.({ part, state: "ready" });
          return true;
        } catch {
          if (valid()) options.onProgress?.({ part, state: "error", text: part === "payment" ? "I couldn't open this payment. Try again, or ask me about something else." : part === "choices" ? "The answer choices couldn't load. You can type your reply or try again." : "Your conversation couldn't load. Please try again." });
          return false;
        } finally { controller.signal.removeEventListener("abort", abort); }
      };
      try {
        if (!options.progressive) await read("thread");
        else {
          const history = read("history");
          const first = target ? read("payment") : history;
          await Promise.all([history, first.then(ready => ready && valid() ? read("choices") : false)]);
        }
      } finally { if (current === controller) current = null; }
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
    paymentNotice: message.paymentNotice,
    newTopic: message.newTopic,
  };
}
