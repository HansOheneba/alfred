import { randomUUID } from "node:crypto";

import { conversationContext, type ConversationContext } from "@/lib/finance/conversation";
import type { FinanceStore } from "@/lib/finance/store";
import type { ProcessedUpdateRecord } from "@/lib/finance/types";

export type ClaimResult =
  | { kind: "replay"; reply: string; pendingActionId?: string }
  | { kind: "in_progress" }
  | { kind: "lost_race" }
  | { kind: "claimed"; rowNumber: number };

type ResultRef = {
  reply?: string;
  pendingActionId?: string;
  claimToken?: string;
  transactionIds?: string[];
  context?: ConversationContext;
};

/**
 * Google Sheets cannot enforce a unique update id or wrap the check and
 * append in a transaction. This claim writes a processing row, reads the
 * rows back, and lets the earliest row continue. A retry of a finished
 * update replays the stored reply instead of writing again.
 * Overlapping requests can still both pass the first read; the second read
 * picks a winner. Move this state to a database if strict uniqueness is required.
 */
export async function claimUpdate(
  store: FinanceStore,
  input: {
    updateId: number;
    userId: string;
    now: Date;
    staleMs: number;
    newToken?: () => string;
  },
): Promise<ClaimResult> {
  await store.ensureReady();
  const updateId = String(input.updateId);
  const token = input.newToken?.() ?? randomUUID();
  const rows = (await store.listProcessedUpdates())
    .filter((row) => row.updateId === updateId)
    .sort((left, right) => left.rowNumber - right.rowNumber);

  const completed = rows.find((row) => row.status === "completed");
  if (completed) return replay(completed);

  const nowMs = input.now.getTime();
  const fresh = rows.find(
    (row) =>
      row.status === "processing" &&
      Number.isFinite(Date.parse(row.processedAt)) &&
      nowMs - Date.parse(row.processedAt) < input.staleMs,
  );
  if (fresh) return { kind: "in_progress" };

  const reusable =
    rows.find((row) => row.status === "processing") ?? rows.find((row) => row.status === "failed");

  if (reusable) {
    const existing = parseRef(reusable.resultReference);
    const nextReference = JSON.stringify({ ...existing, claimToken: token });
    await store.updateProcessedUpdate(reusable.rowNumber, {
      status: "processing",
      processedAt: input.now.toISOString(),
      resultReference: nextReference,
      userId: reusable.userId || input.userId,
    });
    const again = (await store.listProcessedUpdates()).find((row) => row.rowNumber === reusable.rowNumber);
    const ref = parseRef(again?.resultReference ?? "");
    if (!again || again.status !== "processing" || ref.claimToken !== token) {
      return { kind: "lost_race" };
    }
    return { kind: "claimed", rowNumber: again.rowNumber };
  }

  const created = await store.appendProcessedUpdate({
    updateId,
    userId: input.userId,
    status: "processing",
    resultReference: JSON.stringify({ claimToken: token }),
    processedAt: input.now.toISOString(),
  });
  const contenders = (await store.listProcessedUpdates())
    .filter(
      (row) =>
        row.updateId === updateId && (row.status === "processing" || row.status === "completed"),
    )
    .sort((left, right) => left.rowNumber - right.rowNumber);
  const winner = contenders[0];
  if (!winner || winner.rowNumber !== created.rowNumber) {
    await store.updateProcessedUpdate(created.rowNumber, { status: "duplicate_skipped" });
    if (winner?.status === "completed") return replay(winner);
    return { kind: "lost_race" };
  }
  return { kind: "claimed", rowNumber: created.rowNumber };
}

export async function completeUpdate(
  store: FinanceStore,
  rowNumber: number,
  result: { reply: string; pendingActionId?: string; transactionIds?: string[]; context?: ConversationContext | null },
  now: Date,
): Promise<void> {
  await store.updateProcessedUpdate(rowNumber, {
    status: "completed",
    processedAt: now.toISOString(),
    resultReference: JSON.stringify({
      reply: result.reply,
      pendingActionId: result.pendingActionId,
      transactionIds: result.transactionIds ?? [],
      context: result.context ?? undefined,
    }),
  });
}

function replay(row: ProcessedUpdateRecord): ClaimResult {
  const ref = parseRef(row.resultReference);
  return {
    kind: "replay",
    reply: ref.reply || "That update was already processed.",
    pendingActionId: ref.pendingActionId,
  };
}

function parseRef(raw: string): ResultRef {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return {};
    const record = value as Record<string, unknown>;
    return {
      reply: typeof record.reply === "string" ? record.reply : undefined,
      pendingActionId: typeof record.pendingActionId === "string" ? record.pendingActionId : undefined,
      claimToken: typeof record.claimToken === "string" ? record.claimToken : undefined,
      transactionIds: Array.isArray(record.transactionIds)
        ? record.transactionIds.filter((id): id is string => typeof id === "string")
        : undefined,
      context: conversationContext(record.context) ?? undefined,
    };
  } catch {
    return {};
  }
}
