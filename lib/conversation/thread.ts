import type { ChatMessageRecord } from "@/lib/accounts/messages";
import type { WaitingPayments } from "@/lib/bank/reply";
import type { PendingActionRecord } from "@/lib/finance/types";

/** How much of Alfred's last message is quoted back to the model. */
const QUOTE_CHARS = 400;

/** "4 minutes ago", "3 hours ago", "yesterday". */
function ago(at: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(at)) / 60_000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/**
 * What the conversation is waiting on, for the model to read the next
 * message against: what Alfred said last, a confirmation still open, a
 * payment just asked about, or a promise to ask later. Short replies like
 * "ask", "yes" or "the second one" only make sense against these.
 */
export function openThread(input: {
  history: ChatMessageRecord[];
  waiting: WaitingPayments | null;
  pending: PendingActionRecord | null;
  now: Date;
}): string[] {
  const lines: string[] = [];
  const last = [...input.history].reverse().find((item) => item.role === "assistant") ?? null;
  const lastIsAlfred = input.history.at(-1)?.role === "assistant";
  if (last) {
    const quote = last.body.replace(/\s+/g, " ").trim();
    lines.push(`Your last message, ${ago(last.createdAt, input.now)}: "${quote.length > QUOTE_CHARS ? `${quote.slice(0, QUOTE_CHARS)}…` : quote}"`);
  }

  if (input.pending) {
    lines.push("You asked them to confirm something and it's still open. A reply agreeing or refusing, in any words, settles it with answer_confirmation.");
  }

  const waiting = input.waiting;
  const count = waiting?.all.length ?? 0;
  if (waiting && count > 0) {
    const asked = last && lastIsAlfred && /^bank:/.test(last.intent ?? "") && waiting.currentNumber > 0 && last.body.includes("?");
    if (asked) {
      lines.push(`You just asked about waiting payment ${waiting.currentNumber}. A reply that doesn't point at another payment answers it.`);
    } else if (last && /\b(?:in the morning|later|tomorrow)\b/i.test(last.body)) {
      lines.push(`You said you'd ask about the ${count === 1 ? "payment" : `${count} payments`} waiting for a label later. If they say "ask", "go ahead", or similar, they want it now: use ask_next.`);
    } else {
      lines.push(`${count === 1 ? "One payment is" : `${count} payments are`} waiting for a label. If they want to go through them, use ask_next.`);
    }
  }

  if (last && lastIsAlfred && !input.pending && last.body.trim().endsWith("?") && !/^bank:/.test(last.intent ?? "")) {
    lines.push("You ended on a question, so their reply most likely answers it: read it together with what came before.");
  }
  return lines;
}
