import type { SupabaseSettings } from "@/lib/config";
import { logError } from "@/lib/log";
import { query } from "@/lib/supabase/connection";

/**
 * What Alfred learns from. A correction is the person accepting, rejecting or
 * replacing one of Alfred's readings; a trace is a short record of each chat
 * turn, so we can see how often Alfred proposes, refuses or gets corrected.
 * Writing here never changes a reply, and a failed write never breaks one.
 */
export type CorrectionKind = "yes" | "reject" | "edit" | "undo";
export type Correction = { ownerId: string; bankMessageId: string | null; kind: CorrectionKind; userText: string | null; proposed: unknown; final: unknown | null };
export type TurnTrace = { ownerId: string; channel: "web" | "telegram"; actions: string[]; model: string | null; latencyMs: number; intent: string | null; proposed: boolean; refused: boolean };

export interface LearningLog {
  correction(entry: Correction): Promise<void>;
  trace(entry: TurnTrace): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createSupabaseLearningLog(settings: SupabaseSettings): LearningLog {
  return {
    async correction(entry) {
      await query(settings,
        "insert into public.corrections (owner_id, bank_message_id, kind, user_text, proposed, final) values ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::jsonb)",
        [entry.ownerId, entry.bankMessageId && UUID.test(entry.bankMessageId) ? entry.bankMessageId : null, entry.kind, entry.userText?.slice(0, 1000) ?? null,
          JSON.stringify(entry.proposed ?? {}), entry.final == null ? null : JSON.stringify(entry.final)]);
    },
    async trace(entry) {
      await query(settings,
        "insert into public.turn_traces (owner_id, channel, actions, model, latency_ms, intent, proposed, refused) values ($1::uuid, $2, $3::text[], $4, $5, $6, $7, $8)",
        [entry.ownerId, entry.channel, entry.actions.slice(0, 8).map((item) => item.slice(0, 40)), entry.model?.slice(0, 64) ?? null,
          Math.max(0, Math.round(entry.latencyMs)), entry.intent?.slice(0, 80) ?? null, entry.proposed, entry.refused]);
    },
  };
}

/** In-memory log for tests and evals. */
export class MemoryLearningLog implements LearningLog {
  corrections: Correction[] = [];
  traces: TurnTrace[] = [];
  async correction(entry: Correction) { this.corrections.push(entry); }
  async trace(entry: TurnTrace) { this.traces.push(entry); }
}

/** Records without ever failing the turn: the reply matters more than the log. */
export async function remember(log: LearningLog | null | undefined, write: (log: LearningLog) => Promise<void>): Promise<void> {
  if (!log) return;
  try {
    await write(log);
  } catch (error) {
    logError("learning_log", error instanceof Error ? new Error("Learning log write failed.") : error);
  }
}
