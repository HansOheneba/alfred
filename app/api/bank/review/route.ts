import { z } from "zod";

import { applyLabel, undoLabels, type IngestDeps, type Label } from "@/lib/bank/ingest";
import { createSupabaseBankStore, type LabelChange } from "@/lib/bank/store";
import { createSupabaseLoanStore } from "@/lib/finance/loans";
import { newTransactionId } from "@/lib/finance/ids";
import { logError } from "@/lib/log";
import { fail, readBody, requireOwner } from "@/lib/web/api";

/** How long the review page's "Undo" can reverse the last batch, matching "undo" in chat. */
const UNDO_WINDOW_MS = 30 * 60_000;

const reviewBody = z.discriminatedUnion("action", [
  z.object({
    action: z.enum(["category", "chip_in", "transfer", "skip", "lent", "repaid", "borrowed", "paid_back"]),
    messageIds: z.array(z.string().uuid()).min(1).max(50),
    category: z.string().trim().min(1).max(40).optional(),
    description: z.string().trim().max(200).optional(),
    person: z.string().trim().max(120).optional(),
    remember: z.boolean().default(true),
  }),
  z.object({ action: z.literal("undo") }),
]);

/**
 * Labels several held bank payments at once from the review page, or undoes
 * the last batch. Labels from here and from chat share one undo.
 */
export async function POST(request: Request): Promise<Response> {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  const body = await readBody(request, reviewBody);
  if (body instanceof Response) return body;

  const now = new Date();
  const deps: IngestDeps = {
    bank: createSupabaseBankStore(owner.settings.supabase),
    ledger: owner.store,
    loans: createSupabaseLoanStore(owner.settings.supabase),
    now,
    createId: newTransactionId,
  };
  try {
    if (body.action === "undo") {
      const changes = await deps.bank.takeUndo(owner.profile.profileId, new Date(now.getTime() - UNDO_WINDOW_MS));
      if (!changes) return fail("There's nothing to undo.", 409);
      const reopened = await undoLabels(deps, owner.profile, changes);
      return Response.json({ ok: true, text: `Undone. ${reopened === 1 ? "That payment is" : `Those ${reopened} payments are`} waiting again.`, sorted: 0 });
    }

    if ((body.action === "category" || body.action === "chip_in") && !body.category) return fail("Pick a category.", 400);
    const label: Label =
      body.action === "category"
        ? { kind: "category", category: body.category ?? "", description: body.description || null }
        : body.action === "chip_in"
          ? { kind: "chip_in", category: body.category ?? "", description: body.description || null, person: body.person || null }
          : body.action === "lent"
            ? { kind: "lent", person: body.person || null, note: body.description || null }
            : body.action === "borrowed"
              ? { kind: "borrowed", person: body.person || null, note: body.description || null }
              : body.action === "repaid" || body.action === "paid_back"
                ? { kind: body.action, person: body.person || null }
                : { kind: body.action };

    const changes: LabelChange[] = [];
    const problems: string[] = [];
    for (const messageId of body.messageIds) {
      // Remembering a payee files their other waiting payments too.
      if (changes.some((change) => change.messageId === messageId)) continue;
      const result = await applyLabel(deps, owner.profile, messageId, label, { learn: body.remember });
      if (result.ok) changes.push(...result.changes);
      else if (result.text !== "That one is already sorted.") problems.push(result.text);
    }
    if (changes.length > 0) await deps.bank.saveUndo(owner.profile.profileId, changes);
    if (changes.length === 0) return fail(problems[0] ?? "Those payments are already sorted.", 409);
    const sorted = changes.length === 1 ? "Sorted 1 payment." : `Sorted ${changes.length} payments.`;
    return Response.json({ ok: true, text: problems.length ? `${sorted} ${problems[0]}` : sorted, sorted: changes.length });
  } catch (error) {
    logError("bank_review", error);
    return fail("Those payments could not be filed.", 500);
  }
}
