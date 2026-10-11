import { LIMITS, type StudioSettings } from "@/lib/config";
import { authorizeUser } from "@/lib/security/authorization";
import { claimUpdate, completeUpdate } from "@/lib/security/idempotency";
import { interpretMessage, type InterpretRequest } from "@/lib/ai/deepseek";
import { executeConfirmed, handleAction, type ActionContext } from "@/lib/finance/action-router";
import { newActionId, newTransactionId } from "@/lib/finance/ids";
import { pendingPayloadSchema } from "@/lib/finance/schemas";
import type { FinanceAction } from "@/lib/finance/schemas";
import type { FinanceStore } from "@/lib/finance/store";
import { userFacingError } from "@/lib/telegram/messages";
import { logError, logInfo } from "@/lib/log";
import { createSupabaseFinanceStore } from "@/lib/supabase/finance-store";

export const STUDIO_CHAT_ID = 0;

export type StudioTurn =
  | { userId: number; text: string }
  | { userId: number; decision: "confirm" | "cancel"; actionId: string };

export type StudioResult = {
  text: string;
  actionId?: string;
};

export type StudioDeps = {
  settings: StudioSettings;
  store: FinanceStore;
  interpret: (request: InterpretRequest) => Promise<FinanceAction>;
  now: () => Date;
  createId: () => string;
  createActionId: () => string;
  nextUpdateId?: () => number;
};

export async function handleStudioTurn(input: StudioTurn, deps: StudioDeps): Promise<StudioResult> {
  const profile = authorizeUser(input.userId, {
    authorizedUserIds: deps.settings.authorizedUserIds,
    google: deps.settings.google,
    currency: deps.settings.currency,
    timezone: deps.settings.timezone,
  });
  if (!profile) return { text: "That user is not authorized for this console." };

  const now = deps.now();
  const updateId = deps.nextUpdateId?.() ?? now.getTime();
  const claim = await claimUpdate(deps.store, {
    updateId,
    userId: String(profile.telegramUserId),
    now,
    staleMs: LIMITS.processingStaleMs,
  });
  if (claim.kind === "replay") {
    const pendingId = claim.pendingActionId;
    const pending = pendingId ? await deps.store.getPendingAction(pendingId) : null;
    const stillPending =
      pending?.status === "pending" &&
      pending.userId === String(profile.telegramUserId) &&
      pending.chatId === String(STUDIO_CHAT_ID);
    return stillPending && pendingId ? { text: claim.reply, actionId: pendingId } : { text: claim.reply };
  }
  if (claim.kind !== "claimed") {
    return { text: "That request is already being handled. Try again in a moment." };
  }

  const ctx: ActionContext = {
    profile,
    store: deps.store,
    now,
    updateId,
    chatId: STUDIO_CHAT_ID,
    confirmTransactions: deps.settings.confirmTransactions,
    pendingTtlMs: LIMITS.pendingTtlMs,
    createId: deps.createId,
    createActionId: deps.createActionId,
  };

  let result: StudioResult;
  try {
    result = "text" in input ? await answerText(input.text, ctx, deps) : await answerDecision(input, ctx);
  } catch (error) {
    logError("studio_action", error);
    result = { text: userFacingError(error) };
  }

  await completeUpdate(
    deps.store,
    claim.rowNumber,
    { reply: result.text, pendingActionId: result.actionId },
    deps.now(),
  );
  return result;
}

async function answerText(text: string, ctx: ActionContext, deps: StudioDeps): Promise<StudioResult> {
  const userId = String(ctx.profile.telegramUserId);
  const recent = (await deps.store.listTransactions(userId))
    .filter((item) => item.status === "active")
    .sort((left, right) => right.transactionDate.localeCompare(left.transactionDate))
    .slice(0, LIMITS.recentContext)
    .map((item) => ({
      transactionId: item.transactionId,
      transactionDate: item.transactionDate,
      type: item.type,
      amount: item.amount,
      currency: item.currency,
      category: item.category,
      description: item.description.slice(0, 80),
    }));
  const action = await deps.interpret({
    text,
    timezone: ctx.profile.timezone,
    currency: ctx.profile.currency,
    now: ctx.now,
    recent,
  });
  logInfo("studio_interpreted", { userId: ctx.profile.telegramUserId, action: action.type });
  const delivery = await handleAction(action, ctx);
  return delivery.kind === "confirm"
    ? { text: delivery.text, actionId: delivery.actionId }
    : { text: delivery.text };
}

async function answerDecision(
  input: { userId: number; decision: "confirm" | "cancel"; actionId: string },
  ctx: ActionContext,
): Promise<StudioResult> {
  const pending = await ctx.store.getPendingAction(input.actionId);
  const userId = String(ctx.profile.telegramUserId);
  if (!pending || pending.userId !== userId || pending.chatId !== String(STUDIO_CHAT_ID)) {
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
  const text = await executeConfirmed(payload.data, ctx);
  await ctx.store.updatePendingAction(pending.actionId, { status: "completed" });
  return { text };
}

export function createStudioDeps(settings: StudioSettings): StudioDeps {
  let sequence = 0;
  return {
    settings,
    store: createSupabaseFinanceStore(settings.supabase),
    interpret: (request) => interpretMessage(settings.deepseek, request),
    now: () => new Date(),
    createId: newTransactionId,
    createActionId: newActionId,
    nextUpdateId: () => {
      sequence = (sequence + 1) % 1000;
      return Date.now() * 1000 + sequence;
    },
  };
}
