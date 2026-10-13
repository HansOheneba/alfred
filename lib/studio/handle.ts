import { LIMITS, type StudioSettings, type UserProfile } from "@/lib/config";
import { authorizeUser } from "@/lib/security/authorization";
import { claimUpdate, completeUpdate } from "@/lib/security/idempotency";
import { interpretMessage, type InterpretRequest } from "@/lib/ai/deepseek";
import { executeConfirmed, handleAction, type ActionContext } from "@/lib/finance/action-router";
import { newActionId, newTransactionId } from "@/lib/finance/ids";
import { pendingPayloadSchema } from "@/lib/finance/schemas";
import type { FinanceAction } from "@/lib/finance/schemas";
import type { FinanceStore } from "@/lib/finance/store";
import { userFacingError } from "@/lib/telegram/messages";
import { interpretWithContext } from "@/lib/finance/context";
import type { ConversationContext } from "@/lib/finance/conversation";
import { clientTurnUpdateId, type ChatMessageRecord, type MessageLog } from "@/lib/accounts/messages";
import { logError, logInfo } from "@/lib/log";
import { createSupabaseMessageLog } from "@/lib/accounts/supabase-messages";
import { createSupabaseFinanceStore } from "@/lib/supabase/finance-store";

export const STUDIO_CHAT_ID = 0;

export type StudioTurn =
  | { userId: number; text: string }
  | { userId: number; decision: "confirm" | "cancel"; actionId: string };

export type StudioResult = {
  text: string;
  actionId?: string;
  context?: ConversationContext;
  messages?: ChatMessageRecord[];
  pending?: boolean;
};

export type StudioDeps = {
  settings: StudioSettings;
  store: FinanceStore;
  interpret: (request: InterpretRequest) => Promise<FinanceAction>;
  now: () => Date;
  createId: () => string;
  createActionId: () => string;
  nextUpdateId?: () => number;
  messages?: MessageLog | null;
};

export async function handleStudioTurn(input: StudioTurn, deps: StudioDeps): Promise<StudioResult> {
  const profile = authorizeUser(input.userId, {
    authorizedUserIds: deps.settings.authorizedUserIds,
    google: deps.settings.google,
    currency: deps.settings.currency,
    timezone: deps.settings.timezone,
  });
  if (!profile) return { text: "That user is not authorized for this console." };
  return handleProfileTurn(
    profile,
    "text" in input ? { text: input.text } : { decision: input.decision, actionId: input.actionId },
    deps,
  );
}

export async function handleProfileTurn(
  profile: UserProfile,
  input: { text: string; clientId?: string } | { decision: "confirm" | "cancel"; actionId: string; clientId?: string },
  deps: StudioDeps,
): Promise<StudioResult> {
  const now = deps.now();
  const clientId = input.clientId;
  const updateId = clientId ? clientTurnUpdateId(clientId) : (deps.nextUpdateId?.() ?? now.getTime());
  const claim = await claimUpdate(deps.store, {
    updateId,
    userId: profile.profileId,
    now,
    staleMs: LIMITS.processingStaleMs,
  });
  const saved = async () =>
    clientId && deps.messages ? ordered(await deps.messages.listByClientId(profile.profileId, clientId)) : [];
  if (claim.kind === "replay") {
    const pendingId = claim.pendingActionId;
    const pending = pendingId ? await deps.store.getPendingAction(pendingId) : null;
    const stillPending =
      pending?.status === "pending" &&
      pending.userId === profile.profileId &&
      pending.chatId === String(STUDIO_CHAT_ID);
    const messages = await saved();
    return stillPending && pendingId
      ? { text: claim.reply, actionId: pendingId, messages }
      : { text: claim.reply, messages };
  }
  if (claim.kind !== "claimed") {
    return { text: "That request is already being handled. Try again in a moment.", pending: true };
  }

  const existing = await saved();
  const alreadyAnswered = existing.some((message) => message.role === "user") && existing.some((message) => message.role === "assistant");
  if (alreadyAnswered) {
    const assistant = existing.find((message) => message.role === "assistant");
    const text = assistant?.body ?? "";
    await completeUpdate(deps.store, claim.rowNumber, { reply: text }, deps.now());
    return { text, messages: existing };
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
    result = "text" in input ? await answerText(input.text, ctx, deps, clientId) : await answerDecision(input, ctx, deps, clientId);
  } catch (error) {
    logError("studio_action", error);
    if (clientId) {
      await deps.store
        .updateProcessedUpdate(claim.rowNumber, {
          status: "failed",
          processedAt: deps.now().toISOString(),
          resultReference: JSON.stringify({ reply: userFacingError(error) }),
        })
        .catch((updateError) => logError("studio_claim", updateError));
      throw error;
    }
    result = { text: userFacingError(error) };
  }

  await completeUpdate(
    deps.store,
    claim.rowNumber,
    { reply: result.text, pendingActionId: result.actionId, context: result.context },
    deps.now(),
  );
  return result;
}

function ordered(rows: ChatMessageRecord[]): ChatMessageRecord[] {
  return [...rows].sort((left, right) => {
    const byTime = left.createdAt.localeCompare(right.createdAt);
    if (byTime !== 0) return byTime;
    if (left.role !== right.role) return left.role === "user" ? -1 : 1;
    return left.id.localeCompare(right.id);
  });
}

async function answerText(
  text: string,
  ctx: ActionContext,
  deps: StudioDeps,
  clientId?: string,
): Promise<StudioResult> {
  if (deps.messages && clientId) {
    await deps.messages.append({
      ownerId: ctx.profile.profileId,
      role: "user",
      body: text,
      channel: "web",
      clientId,
    });
  }
  const { action, context } = await interpretWithContext({
    text,
    profile: ctx.profile,
    store: deps.store,
    now: ctx.now,
    interpret: deps.interpret,
    messages: deps.messages,
    excludeClientId: clientId,
  });
  logInfo("studio_interpreted", { userId: ctx.profile.profileId, action: action.type });
  const delivery = await handleAction(action, { ...ctx, conversation: context });
  if (deps.messages) {
    if (!clientId) {
      await deps.messages.append({ ownerId: ctx.profile.profileId, role: "user", body: text, channel: "web" });
    }
    await deps.messages.append({
      ownerId: ctx.profile.profileId,
      role: "assistant",
      body: delivery.text,
      channel: "web",
      clientId,
    });
  }
  const messages =
    clientId && deps.messages ? ordered(await deps.messages.listByClientId(ctx.profile.profileId, clientId)) : undefined;
  return delivery.kind === "confirm"
    ? { text: delivery.text, actionId: delivery.actionId, context: delivery.context, messages }
    : { text: delivery.text, context: delivery.context, messages };
}

async function answerDecision(
  input: { decision: "confirm" | "cancel"; actionId: string },
  ctx: ActionContext,
  deps: StudioDeps,
  clientId?: string,
): Promise<StudioResult> {
  const result = await decide(input, ctx);
  if (deps.messages) {
    await deps.messages.append({
      ownerId: ctx.profile.profileId,
      role: "user",
      body: input.decision === "confirm" ? "Confirm" : "Cancel",
      channel: "web",
      clientId,
    });
    await deps.messages.append({
      ownerId: ctx.profile.profileId,
      role: "assistant",
      body: result.text,
      channel: "web",
      clientId,
    });
  }
  const messages =
    clientId && deps.messages ? ordered(await deps.messages.listByClientId(ctx.profile.profileId, clientId)) : undefined;
  return { ...result, messages };
}

async function decide(
  input: { decision: "confirm" | "cancel"; actionId: string },
  ctx: ActionContext,
): Promise<StudioResult> {
  const pending = await ctx.store.getPendingAction(input.actionId);
  const userId = ctx.profile.profileId;
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
  const confirmed = await executeConfirmed(payload.data, ctx);
  await ctx.store.updatePendingAction(pending.actionId, { status: "completed" });
  return { text: confirmed.text, context: confirmed.context };
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
    messages: createSupabaseMessageLog(settings.supabase),
  };
}
