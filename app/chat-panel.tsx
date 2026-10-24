"use client";

import { useEffect, useRef, useState } from "react";

import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { mergeThread, threadKey, type ThreadMessage } from "@/lib/accounts/thread";

type ServerMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  channel: "web" | "telegram";
  createdAt: string;
  clientId: string | null;
};

export function ChatPanel({ ownerId, initialMessages }: { ownerId: string; initialMessages: ThreadMessage[] }) {
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<ThreadMessage[]>(initialMessages);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);
  const sending = useRef(false);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const node = threadRef.current;
    if (!node || !stickToBottom.current) return;
    node.scrollTop = node.scrollHeight;
  }, [messages, busy]);

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
          };
          setMessages((current) => mergeThread(current, [incoming]));
        },
      )
      .subscribe();
    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [ownerId]);

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
    } catch {
      if (userText && turnId) markFailed(turnId);
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

  function canRetry(message: ThreadMessage, index: number): boolean {
    if (message.role !== "user" || busy || !message.clientId || message.status === "sending") return false;
    if (message.status === "failed") return true;
    return index === messages.length - 1 && !messages.slice(index + 1).some((item) => item.role === "assistant");
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={threadRef}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-700"
        aria-busy={busy}
        onScroll={onThreadScroll}
      >
        <div className="mx-auto flex w-full max-w-[840px] flex-col gap-5 px-4 py-6" role="log" aria-label="Conversation" aria-relevant="additions">
          {messages.length === 0 ? (
            <p className="pt-6 text-sm leading-6 text-neutral-400">Message Alfred. The same conversation is available on Telegram.</p>
          ) : (
            messages.map((message, index) => (
              <article key={threadKey(message)} className={message.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div className={message.role === "user" ? "max-w-[85%]" : "max-w-[85%]"}>
                  {message.role === "assistant" ? (
                    <p className="mb-1.5 text-xs tracking-wide text-neutral-500">
                      Alfred{message.channel === "telegram" ? " · Telegram" : ""}
                    </p>
                  ) : message.channel === "telegram" ? (
                    <p className="mb-1.5 text-right text-xs tracking-wide text-neutral-500">Telegram</p>
                  ) : null}
                  <div
                    className={
                      message.role === "user"
                        ? "rounded-2xl rounded-br-md border border-white/10 bg-neutral-800 px-4 py-2.5 text-neutral-50"
                        : "rounded-2xl rounded-bl-md border border-white/10 bg-neutral-950 px-4 py-2.5 text-neutral-100"
                    }
                  >
                    <p className="whitespace-pre-wrap text-[15px] leading-6">{message.text}</p>
                    {message.role === "assistant" && message.actionId && !message.settled ? (
                      <div className="mt-3 flex gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          className="rounded-full bg-neutral-100 px-3 py-1 text-xs text-neutral-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400 disabled:opacity-40"
                          onClick={() => void send({ decision: "confirm", actionId: message.actionId, clientId: `confirm-${message.actionId}` })}
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          className="rounded-full border border-white/15 px-3 py-1 text-xs text-neutral-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400 disabled:opacity-40"
                          onClick={() => void send({ decision: "cancel", actionId: message.actionId, clientId: `cancel-${message.actionId}` })}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : null}
                  </div>
                  {message.role === "user" && canRetry(message, index) ? (
                    <div className="mt-2 flex justify-end">
                      <button
                        type="button"
                        className="text-xs text-red-300 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400"
                        onClick={() => submitText(message.text, message.clientId ?? undefined)}
                      >
                        Retry
                      </button>
                    </div>
                  ) : null}
                </div>
              </article>
            ))
          )}
          {busy ? (
            <p className="text-sm text-neutral-500" role="status">
              Alfred is thinking
            </p>
          ) : null}
          {error ? (
            <p className="text-sm text-red-300" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </div>
      <form
        className="shrink-0 border-t border-white/10 bg-black"
        onSubmit={(event) => {
          event.preventDefault();
          submitText(text);
        }}
      >
        <div className="mx-auto w-full max-w-[840px] px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <label className="sr-only" htmlFor="alfred-message">
            Message Alfred
          </label>
          <div className="flex items-end gap-2 rounded-2xl border border-white/10 bg-neutral-950 px-3 py-2 focus-within:border-white/30">
            <textarea
              id="alfred-message"
              className="max-h-40 min-h-10 flex-1 resize-none bg-transparent py-2 text-[15px] leading-6 text-neutral-100 outline-none placeholder:text-neutral-500"
              value={text}
              maxLength={2000}
              rows={1}
              placeholder="Message Alfred"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <button
              type="submit"
              disabled={busy || text.trim().length === 0}
              className="mb-1 rounded-full bg-neutral-100 px-3 py-1.5 text-sm text-neutral-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400 disabled:opacity-40"
            >
              Send
            </button>
          </div>
          <p className="mt-2 text-xs text-neutral-600">Enter to send. Shift+Enter for a new line.</p>
        </div>
      </form>
    </div>
  );
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
  };
}
