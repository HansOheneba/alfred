import { executeConfirmed, type ActionContext } from "@/lib/finance/action-router";
import type { ConversationContext } from "@/lib/finance/conversation";
import { pendingPayloadSchema } from "@/lib/finance/schemas";
import type { FinanceStore } from "@/lib/finance/store";

export type Decision = "confirm" | "cancel";

const CONFIRM = /^(?:y|yes|yeah|yep|yup|ok|okay|sure|confirm|confirmed|go ahead|do it|save it|correct)$/;
const CANCEL = /^(?:n|no|nope|nah|cancel|stop|don't|dont|never ?mind)$/;

/** A short typed reply that answers an open confirmation, or null for anything else. */
export function typedDecision(text: string): Decision | null {
  const value = text.toLowerCase().replace(/['’]/g, "'").replace(/[\s!.]+$/g, "").trim();
  if (CONFIRM.test(value)) return "confirm";
  if (CANCEL.test(value)) return "cancel";
  return null;
}

/** The newest unexpired confirmation this user still has open, from any channel. */
export async function latestOpenPending(store: FinanceStore, userId: string, now: Date) {
  const open = (await store.listPendingActions(userId)).filter(
    (action) => action.status === "pending" && Date.parse(action.expiresAt) > now.getTime(),
  );
  return open.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

/**
 * Settles one confirmation. `chatId` limits it to the chat that showed the
 * buttons; pass null for a typed reply, which only needs the same owner.
 */
export async function decidePending(
  input: { decision: Decision; actionId: string; chatId: string | null },
  ctx: ActionContext,
): Promise<{ text: string; context?: ConversationContext }> {
  const pending = await ctx.store.getPendingAction(input.actionId);
  if (!pending || pending.userId !== ctx.profile.profileId || (input.chatId !== null && pending.chatId !== input.chatId)) {
    return { text: "That confirmation isn't for this chat." };
  }
  if (Date.parse(pending.expiresAt) <= ctx.now.getTime() && pending.status === "pending") {
    await ctx.store.updatePendingAction(pending.actionId, { status: "expired" });
    return { text: "That confirmation expired. Send the request again. Nothing was changed." };
  }
  if (pending.status === "completed") return { text: "That was already confirmed." };
  if (pending.status === "cancelled" || pending.status === "expired") {
    return { text: "That confirmation is closed. Nothing was changed." };
  }
  if (input.decision === "cancel") {
    await ctx.store.updatePendingAction(pending.actionId, { status: "cancelled" });
    return { text: "Cancelled. Nothing was changed." };
  }
  let raw: unknown = null;
  try {
    raw = JSON.parse(pending.payloadJson) as unknown;
  } catch {
    raw = null;
  }
  const payload = pendingPayloadSchema.safeParse(raw);
  if (!payload.success || payload.data.type !== pending.actionType) {
    await ctx.store.updatePendingAction(pending.actionId, { status: "cancelled" });
    return { text: "That confirmation is no longer valid. Nothing was changed." };
  }
  await ctx.store.updatePendingAction(pending.actionId, { status: "processing" });
  const confirmed = await executeConfirmed(payload.data, ctx);
  await ctx.store.updatePendingAction(pending.actionId, { status: "completed" });
  return { text: confirmed.text, context: confirmed.context };
}

/** Answers a typed yes or no when a confirmation is open; otherwise returns null. */
export async function answerTypedDecision(
  text: string,
  ctx: ActionContext,
): Promise<{ text: string; context?: ConversationContext } | null> {
  const decision = typedDecision(text);
  if (!decision) return null;
  const open = await latestOpenPending(ctx.store, ctx.profile.profileId, ctx.now);
  if (!open) return null;
  return decidePending({ decision, actionId: open.actionId, chatId: null }, ctx);
}
