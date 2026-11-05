import { clientTurnUpdateId, isClientMessageId, type ChatMessageRecord } from "@/lib/accounts/messages";
import { executeConfirmed, handleAction, type ActionContext } from "@/lib/finance/action-router";
import type { ConversationContext } from "@/lib/finance/conversation";
import { offeredActions, pendingPayloadSchema, type FinanceAction } from "@/lib/finance/schemas";
import type { FinanceStore } from "@/lib/finance/store";
import { remember } from "@/lib/learning/log";

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
    (action) => action.status === "pending" && action.actionType !== "account_rule_command" && Date.parse(action.expiresAt) > now.getTime(),
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
  if (pending.actionType === "account_rule_command") return { text: `Account rules require their explicit command. Use /rule confirm ${pending.actionId} or /rule cancel ${pending.actionId} in the original chat.` };
  if (Date.parse(pending.expiresAt) <= ctx.now.getTime() && pending.status === "pending") {
    await ctx.store.updatePendingAction(pending.actionId, { status: "expired" });
    return { text: "That confirmation expired. Send the request again. Nothing was changed." };
  }
  if (pending.status === "completed") return { text: "That was already confirmed." };
  if (pending.status === "cancelled" || pending.status === "expired") {
    return { text: "That confirmation is closed. Nothing was changed." };
  }
  let raw: unknown = null;
  try {
    raw = JSON.parse(pending.payloadJson) as unknown;
  } catch {
    raw = null;
  }
  // Saying yes or no to Alfred's reading of a payment is what it learns from.
  if (pending.actionType === "label_payments") {
    const items = (raw as { items?: { bankMessageId?: string }[] } | null)?.items ?? [];
    await remember(ctx.learning, (log) => log.correction({ ownerId: ctx.profile.profileId, bankMessageId: items[0]?.bankMessageId ?? null,
      kind: input.decision === "confirm" ? "yes" : "reject", userText: null, proposed: items, final: input.decision === "confirm" ? items : null }));
  }
  if (input.decision === "cancel") {
    await ctx.store.updatePendingAction(pending.actionId, { status: "cancelled" });
    return { text: "Cancelled. Nothing was changed." };
  }
  const payload = pendingPayloadSchema.safeParse(raw);
  if (!payload.success || payload.data.type !== pending.actionType) {
    await ctx.store.updatePendingAction(pending.actionId, { status: "cancelled" });
    return { text: "That confirmation is no longer valid. Nothing was changed." };
  }
  await ctx.store.updatePendingAction(pending.actionId, { status: "processing" });
  if (payload.data.type === "offer") {
    const done = await doOffer(offeredActions(payload.data.actions), ctx, String(pending.chatId));
    await ctx.store.updatePendingAction(pending.actionId, { status: "completed" });
    return done;
  }
  const confirmed = await executeConfirmed(payload.data, ctx);
  await ctx.store.updatePendingAction(pending.actionId, { status: "completed" });
  return { text: confirmed.text, context: confirmed.context };
}

/**
 * The confirmation Alfred's message showed, while it's still open, so a chat
 * that reloads keeps its Yes and No. Only a confirmation from that same turn counts.
 */
export async function openConfirmationFor(store: FinanceStore, ownerId: string, message: Pick<ChatMessageRecord, "role" | "clientId"> | undefined, now: Date): Promise<string | null> {
  if (!message || message.role !== "assistant" || !message.clientId || !isClientMessageId(message.clientId)) return null;
  const origin = String(clientTurnUpdateId(message.clientId));
  const open = (await store.listPendingActions(ownerId)).find((pending) => {
    if (pending.userId !== ownerId || pending.status !== "pending" || pending.actionType === "account_rule_command" || Date.parse(pending.expiresAt) <= now.getTime()) return false;
    try {
      return (JSON.parse(pending.payloadJson) as { originUpdateId?: unknown }).originUpdateId === origin;
    } catch {
      return false;
    }
  });
  return open?.actionId ?? null;
}

/**
 * Does what a question offered, now that the person said yes to it. The yes
 * covers the action's own confirmation, so it isn't asked a second time.
 */
async function doOffer(actions: FinanceAction[], ctx: ActionContext, chatId: string): Promise<{ text: string; context?: ConversationContext }> {
  if (actions.length === 0) return { text: "That offer is no longer valid. Nothing was changed." };
  const lines: string[] = [];
  let context: ConversationContext | undefined;
  for (const action of actions) {
    const delivery = await handleAction(action.type === "create_transaction" ? { ...action, explicit: true } : action, ctx);
    if (delivery.kind === "confirm") {
      const settled = await decidePending({ decision: "confirm", actionId: delivery.actionId, chatId }, ctx);
      lines.push(settled.text);
      context = settled.context ?? context;
    } else {
      lines.push(delivery.text);
      context = delivery.context ?? context;
    }
  }
  return { text: lines.join("\n\n"), context };
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
