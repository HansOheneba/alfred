/** What the chat route streams: steps while Alfred works, then the reply. */
export const TURN_STREAM = "application/x-ndjson";

/**
 * Reads a chat reply, passing each live step on as it arrives. A plain JSON
 * reply (an older server, or an error before streaming began) reads the same
 * way, so the caller handles one shape.
 */
export async function readTurnResponse<T>(response: Response, onStep: (text: string) => void): Promise<{ ok: boolean; payload: T }> {
  if (!response.body || !response.headers.get("content-type")?.includes(TURN_STREAM)) {
    return { ok: response.ok, payload: (await response.json()) as T };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      const event = JSON.parse(line) as { type?: string; text?: unknown; status?: unknown; body?: unknown };
      if (event.type === "step" && typeof event.text === "string") onStep(event.text);
      if (event.type === "result") {
        void reader.cancel().catch(() => undefined);
        const status = typeof event.status === "number" ? event.status : 500;
        return { ok: status >= 200 && status < 300, payload: event.body as T };
      }
    }
    if (done) break;
  }
  throw new Error("The reply ended before it arrived.");
}

/** How many words of a reply to show after `elapsed` ms: quick, and never longer than about a second and a half. */
export function revealedWords(total: number, elapsed: number): number {
  if (total <= 0) return 0;
  const perWord = Math.min(28, Math.max(9, 1400 / total));
  return Math.min(total, Math.floor(elapsed / perWord) + 1);
}
