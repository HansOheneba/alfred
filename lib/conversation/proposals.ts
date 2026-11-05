import type { Label } from "@/lib/bank/ingest";
import { waitingLine } from "@/lib/bank/reply";
import type { BankMessage } from "@/lib/bank/store";
import type { UserProfile } from "@/lib/config";
import { saveConfirmation, type ActionContext, type Delivery } from "@/lib/finance/action-router";
import { normalizeCategory } from "@/lib/finance/categories";
import { proposedLabelSchema } from "@/lib/finance/schemas";
import { remember } from "@/lib/learning/log";

/** One captured payment and the label Alfred read from the person's words. */
export type Proposal = { message: BankMessage; label: Label };

/** How long a proposed reading of a payment can still be confirmed. */
const PROPOSAL_TTL_MS = 24 * 60 * 60_000;

/** How long either side of the asked payment another alert counts as "around the same time". */
const NEARBY_MS = 2 * 60 * 60_000;

/**
 * Waiting payments close in time to the one being asked about, as lines the
 * model can refer to by number: a card top-up and the charge minutes later
 * are usually one story.
 */
export function nearbyPayments(current: BankMessage, listed: BankMessage[], profile: UserProfile): string[] {
  const at = Date.parse(current.occurredAt);
  return listed
    .map((message, index) => ({ message, number: index + 1 }))
    .filter(({ message }) => message.id !== current.id && message.ownerId === current.ownerId && Math.abs(Date.parse(message.occurredAt) - at) <= NEARBY_MS)
    .map(({ message, number }) => `${number}. ${message.direction === "in" ? "IN" : "OUT"} ${waitingLine(message, profile)} at ${timeOf(message, profile)}`);
}

/** Ids of waiting payments close in time to the one being asked about. */
export function nearbyIds(current: BankMessage, listed: BankMessage[]): Set<string> {
  const at = Date.parse(current.occurredAt);
  return new Set(listed.filter((message) => message.id !== current.id && message.ownerId === current.ownerId && Math.abs(Date.parse(message.occurredAt) - at) <= NEARBY_MS).map((message) => message.id));
}

/**
 * What to do with the model's labels when Alfred has asked about one payment.
 * The same rule applies whether the person is replying to an alert or to
 * Alfred's question in chat:
 * - file: their words name this payment's purpose, so file it now (with undo);
 * - propose: the reading fits their words without naming it, or also covers a
 *   payment from around the same time, so show it and wait for a yes;
 * - ask: nothing usable, so ask again with the answer buttons. Never a dead end.
 * Labels for other, older payments the person named are left to the normal path.
 */
export type AnswerDecision = { kind: "file" } | { kind: "propose"; items: Proposal[] } | { kind: "ask" };

export function decidePaymentAnswer(input: {
  text: string;
  asked: BankMessage;
  proposals: Proposal[];
  nearby: Set<string>;
  grounded: (text: string, message: BankMessage, label: Label) => boolean;
  proposable: (text: string, message: BankMessage, label: Label) => boolean;
}): AnswerDecision {
  const { text, asked, nearby } = input;
  const relevant = input.proposals.filter((item) => item.message.id === asked.id || nearby.has(item.message.id));
  if (relevant.length === 0) return input.proposals.length > 0 ? { kind: "file" } : { kind: "ask" };
  if (relevant.every((item) => item.message.id === asked.id && fitsDirection(item.message, item.label) && input.grounded(text, item.message, item.label))) return { kind: "file" };
  const fit = relevant.filter((item) => fitsDirection(item.message, item.label) && (input.grounded(text, item.message, item.label) || input.proposable(text, item.message, item.label)));
  if (fit.length === relevant.length && fit.some((item) => item.message.id === asked.id)) return { kind: "propose", items: fit };
  return { kind: "ask" };
}

function timeOf(message: BankMessage, profile: UserProfile): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: profile.timezone }).format(new Date(message.occurredAt));
}

/** Labels that can't apply to a payment going this way, like lending money that came in. */
export function fitsDirection(message: BankMessage, label: Label): boolean {
  if (label.kind === "lent" || label.kind === "paid_back") return message.direction === "out";
  if (label.kind === "repaid" || label.kind === "borrowed" || label.kind === "refund") return message.direction === "in";
  if (label.kind === "category") return Boolean(normalizeCategory(label.category, message.direction === "in" ? "income" : "expense"));
  return true;
}

/** "money you lent George", said the way a person would. */
export function describeLabel(message: BankMessage, label: Label): string {
  const who = (name: string | null | undefined, fallback: string) => name?.trim() || fallback;
  switch (label.kind) {
    case "category": return `${label.category}${label.description ? ` (${label.description})` : ""}`;
    case "transfer": return "your own money moving between your accounts, not income or spending";
    case "pass_through": return `money handled for ${who(label.person, "someone else")}, not yours`;
    case "refund": return `a refund that lowers your ${label.category} spending`;
    case "lent": return `money you lent ${who(label.person, "someone")}, so they owe it back`;
    case "repaid": return `${who(label.person, "someone")} paying you back`;
    case "borrowed": return `money ${who(label.person, "someone")} lent you, so you owe it back`;
    case "paid_back": return `you paying ${who(label.person, "someone")} back`;
    case "invest": return `money into ${who(label.investment, "an investment")}`;
    case "chip_in": return `${who(label.person, "someone")}'s share of ${label.category}`;
    case "skip": return "left out";
  }
}

/**
 * Shows what Alfred understood and asks before filing anything. Returns null
 * when none of the readings can apply, so the caller asks the question again.
 */
export async function proposeLabels(ctx: ActionContext, proposals: Proposal[], profile: UserProfile, said: string | null = null): Promise<Delivery | null> {
  const seen = new Set<string>();
  const usable = proposals.filter((item) => {
    if (seen.has(item.message.id) || item.message.ownerId !== profile.profileId || item.message.status !== "needs_label" || !fitsDirection(item.message, item.label)) return false;
    seen.add(item.message.id);
    return proposedLabelSchema.safeParse(item.label).success;
  }).slice(0, 4);
  if (usable.length === 0 || !ctx.labelPayments) return null;
  // A newer reading replaces any earlier one for the same payments, so "yes" can only confirm the latest.
  const items = usable.map((item) => ({ bankMessageId: item.message.id, label: proposedLabelSchema.parse(item.label) }));
  for (const message of usable) {
    const earlier = await openLabelProposal(ctx, message.message.id);
    if (!earlier) continue;
    await ctx.store.updatePendingAction(earlier.actionId, { status: "cancelled" });
    // The person changed Alfred's reading: the old one and what replaced it are a lesson.
    const before = await ctx.store.getPendingAction(earlier.actionId);
    let proposed: unknown = [];
    try { proposed = (JSON.parse(before?.payloadJson ?? "{}") as { items?: unknown }).items ?? []; } catch { proposed = []; }
    await remember(ctx.learning, (log) => log.correction({ ownerId: profile.profileId, bankMessageId: message.message.id, kind: "edit", userText: said, proposed, final: items }));
  }
  const lines = usable.map((item) => `• ${waitingLine(item.message, profile)}: ${describeLabel(item.message, item.label)}`);
  const text = [usable.length === 1 ? "Here's how I read that:" : "Here's how I read those:", ...lines, "", "Save this? Nothing changes until you confirm."].join("\n");
  // A reading of a payment stays answerable for a day: people come back to it later.
  return saveConfirmation({ ...ctx, pendingTtlMs: PROPOSAL_TTL_MS }, text, {
    type: "label_payments",
    originUpdateId: String(ctx.updateId),
    items,
  });
}

/** The open proposal that names this payment, so a typed "yes" confirms that reading and nothing older. */
export async function openLabelProposal(ctx: ActionContext, bankMessageId: string): Promise<{ actionId: string } | null> {
  const open = (await ctx.store.listPendingActions(ctx.profile.profileId)).filter((action) => {
    if (action.userId !== ctx.profile.profileId || action.status !== "pending" || action.actionType !== "label_payments" || Date.parse(action.expiresAt) <= ctx.now.getTime()) return false;
    try {
      const payload = JSON.parse(action.payloadJson) as { items?: { bankMessageId?: unknown }[] };
      return Boolean(payload.items?.some((item) => item.bankMessageId === bankMessageId));
    } catch {
      return false;
    }
  });
  return open.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}
