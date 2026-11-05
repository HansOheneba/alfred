/**
 * Finds conversations that went wrong, from what Alfred already records:
 * its replies, the turn traces, corrections and open confirmations. It reads
 * plain rows, so the daily review script feeds it from the database and the
 * tests feed it samples. Nothing here writes anything.
 */

export type ReviewMessage = { ownerId: string; role: "user" | "assistant"; body: string; intent: string | null; createdAt: string; bankMessageId: string | null };
export type ReviewTrace = { ownerId: string; refused: boolean; actions: string[]; createdAt: string };
export type ReviewCorrection = { ownerId: string; kind: string; bankMessageId: string | null; createdAt: string };
export type ReviewPending = { ownerId: string; actionType: string; status: string; createdAt: string; expiresAt: string };

export type IncidentKind = "fallback" | "refused" | "rejected" | "expired";
export type Incident = {
  kind: IncidentKind;
  ownerId: string;
  at: string;
  /** What went wrong, in a line. */
  what: string;
  /** How many failures this one stands for, when several came close together. */
  count: number;
  /** The conversation leading up to it and the reply, oldest first. */
  messages: { role: "user" | "assistant"; body: string; at: string }[];
  bankMessageIds: string[];
};

/** Replies that mean Alfred didn't manage what the person asked. */
export const FALLBACKS: { pattern: RegExp; what: string }[] = [
  { pattern: /couldn't tell which waiting payments/i, what: "generic 'couldn't tell which payments' reply" },
  { pattern: /nothing waiting for a yes or no/i, what: "a yes found nothing to confirm" },
  { pattern: /category doesn't fit|isn't one of the categories/i, what: "category didn't fit the payment" },
  { pattern: /haven't changed this payment/i, what: "refused to file a payment answer" },
  { pattern: /couldn't understand that answer|not quite with you|didn't quite catch that/i, what: "didn't understand the reply" },
  { pattern: /couldn't find that in your records/i, what: "lookup found nothing" },
  { pattern: /^Here's what I found:/i, what: "lookup answer replaced by raw results (unsupported figure)" },
  { pattern: /thinking is running slow/i, what: "model was down or too slow" },
  { pattern: /can't think right now/i, what: "model provider refused Alfred (out of credit or bad key)" },
  { pattern: /couldn't match that to a payment/i, what: "answer matched no payment" },
];

/** Failures by the same person this close together are one incident. */
const MERGE_MS = 30 * 60_000;
/** Messages shown before the failing reply. */
const CONTEXT = 6;

export function findIncidents(input: {
  messages: ReviewMessage[];
  traces: ReviewTrace[];
  corrections: ReviewCorrection[];
  pending: ReviewPending[];
  since: Date;
  now: Date;
}): Incident[] {
  const inWindow = (at: string) => Date.parse(at) >= input.since.getTime() && Date.parse(at) <= input.now.getTime();
  const byOwner = new Map<string, ReviewMessage[]>();
  for (const message of [...input.messages].sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
    byOwner.set(message.ownerId, [...(byOwner.get(message.ownerId) ?? []), message]);
  }
  const around = (ownerId: string, at: string) => {
    const thread = byOwner.get(ownerId) ?? [];
    const end = thread.findLastIndex((message) => message.createdAt <= at);
    return thread.slice(Math.max(0, end - CONTEXT), end + 1);
  };
  const incident = (kind: IncidentKind, ownerId: string, at: string, what: string): Incident => {
    const messages = around(ownerId, at);
    return {
      kind, ownerId, at, what, count: 1,
      messages: messages.map((message) => ({ role: message.role, body: message.body, at: message.createdAt })),
      bankMessageIds: [...new Set(messages.flatMap((message) => (message.bankMessageId ? [message.bankMessageId] : [])))],
    };
  };

  const found: Incident[] = [];
  for (const message of input.messages) {
    if (message.role !== "assistant" || !inWindow(message.createdAt)) continue;
    const fallback = FALLBACKS.find((item) => item.pattern.test(message.body));
    if (fallback) found.push(incident("fallback", message.ownerId, message.createdAt, fallback.what));
  }
  for (const trace of input.traces) {
    if (!trace.refused || !inWindow(trace.createdAt)) continue;
    // A refusal's reply is usually already a fallback; only count ones the patterns missed.
    const seen = found.some((item) => item.ownerId === trace.ownerId && Math.abs(Date.parse(item.at) - Date.parse(trace.createdAt)) < 15_000);
    if (!seen) found.push(incident("refused", trace.ownerId, trace.createdAt, `turn refused (${trace.actions.join("+") || "no action"})`));
  }
  for (const correction of input.corrections) {
    if (correction.kind === "reject" && inWindow(correction.createdAt)) {
      found.push(incident("rejected", correction.ownerId, correction.createdAt, "the person said no to Alfred's reading"));
    }
  }
  for (const pending of input.pending) {
    if (!["label_payments", "offer"].includes(pending.actionType) || pending.status !== "pending" || !inWindow(pending.expiresAt)) continue;
    found.push(incident("expired", pending.ownerId, pending.createdAt, `${pending.actionType === "offer" ? "an offer" : "a payment reading"} expired without an answer`));
  }

  // One incident per stretch of trouble: a person stuck for 10 minutes is one problem, not five.
  const merged: Incident[] = [];
  for (const item of found.sort((left, right) => left.ownerId.localeCompare(right.ownerId) || left.at.localeCompare(right.at))) {
    const last = merged.at(-1);
    if (last && last.ownerId === item.ownerId && Date.parse(item.at) - Date.parse(last.at) <= MERGE_MS) {
      const seen = new Set(last.messages.map((message) => `${message.at}|${message.body}`));
      last.messages.push(...item.messages.filter((message) => !seen.has(`${message.at}|${message.body}`)));
      last.messages.sort((left, right) => left.at.localeCompare(right.at));
      last.bankMessageIds = [...new Set([...last.bankMessageIds, ...item.bankMessageIds])];
      if (!last.what.includes(item.what)) last.what = `${last.what}; ${item.what}`;
      last.count += 1;
      last.at = item.at;
    } else {
      merged.push({ ...item, messages: [...item.messages] });
    }
  }
  return merged.sort((left, right) => left.at.localeCompare(right.at));
}
