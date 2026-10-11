"use client";

import { useEffect, useRef, useState } from "react";

const EXAMPLES = ["I spent GH₵45 on lunch", "How much have I spent this month?"];

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  actionId?: string | null;
  settled?: boolean;
};

type Props = {
  userIds: number[];
  configError?: string;
};

export function StudioConsole({ userIds, configError }: Props) {
  const [userId, setUserId] = useState(userIds[0] ? String(userIds[0]) : "");
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(configError ?? "");
  const threadRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(0);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [messages, busy]);

  function messageId(): string {
    nextId.current += 1;
    return String(nextId.current);
  }

  async function send(body: Record<string, unknown>, userText?: string) {
    const id = Number(userId);
    if (!Number.isSafeInteger(id)) return;
    setBusy(true);
    setError("");
    if (userText) {
      const userMessageId = messageId();
      setMessages((current) => [...current, { id: userMessageId, role: "user", text: userText }]);
      setText("");
    }
    try {
      const response = await fetch("/api/studio", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, userId: id }),
      });
      const payload = (await response.json()) as { ok?: boolean; text?: string; actionId?: string | null };
      if (!response.ok || !payload.ok) {
        setError(payload.text || "The console could not complete that request.");
        return;
      }
      const assistantId = messageId();
      setMessages((current) => [
        ...current.map((message) =>
          body.actionId && message.actionId === body.actionId ? { ...message, settled: true } : message,
        ),
        {
          id: assistantId,
          role: "assistant",
          text: payload.text ?? "",
          actionId: payload.actionId,
        },
      ]);
    } catch {
      setError("The console could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex h-dvh w-full max-w-3xl flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <h1 className="text-base font-semibold tracking-tight">Alfred</h1>
        {userIds.length > 0 ? (
          <label className="flex items-center gap-2 text-xs text-neutral-500">
            User
            <select
              className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm text-neutral-900 dark:border-neutral-700 dark:text-neutral-100"
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
            >
              {userIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </header>

      <div ref={threadRef} className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-6">
        {userIds.length === 0 ? (
          <p className="m-auto max-w-sm text-center text-sm text-red-700 dark:text-red-400">
            {error || "No authorized users are configured."}
          </p>
        ) : messages.length === 0 ? (
          <div className="m-auto flex max-w-md flex-col items-center gap-4 text-center">
            <p className="text-lg font-medium">What should I record?</p>
            <div className="flex flex-wrap justify-center gap-2">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  className="rounded-full border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700"
                  onClick={() => setText(example)}
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <div key={message.id} className={message.role === "user" ? "flex justify-end" : "flex justify-start"}>
              <div
                className={
                  message.role === "user"
                    ? "max-w-[85%] rounded-2xl bg-neutral-900 px-4 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
                    : "max-w-[85%] rounded-2xl bg-neutral-100 px-4 py-2 text-sm dark:bg-neutral-900"
                }
              >
                <p className="whitespace-pre-wrap leading-6">{message.text}</p>
                {message.role === "assistant" && message.actionId && !message.settled ? (
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      className="rounded-full bg-neutral-900 px-3 py-1 text-xs text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
                      onClick={() =>
                        void send({ decision: "confirm", actionId: message.actionId }, "Confirm")
                      }
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      className="rounded-full border border-neutral-300 px-3 py-1 text-xs disabled:opacity-50 dark:border-neutral-700"
                      onClick={() => void send({ decision: "cancel", actionId: message.actionId }, "Cancel")}
                    >
                      Cancel
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ))
        )}
        {busy ? <p className="text-xs text-neutral-500">Alfred is writing…</p> : null}
        {error && userIds.length > 0 ? <p className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}
      </div>

      {userIds.length > 0 ? (
        <form
          className="border-t border-neutral-200 p-4 dark:border-neutral-800"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = text.trim();
            if (!trimmed || busy) return;
            void send({ text: trimmed }, trimmed);
          }}
        >
          <div className="flex items-end gap-2 rounded-3xl border border-neutral-300 px-3 py-2 dark:border-neutral-700">
            <textarea
              className="max-h-40 min-h-10 flex-1 resize-none bg-transparent py-2 text-sm outline-none"
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
              className="mb-1 rounded-full bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
            >
              Send
            </button>
          </div>
        </form>
      ) : null}
    </main>
  );
}
