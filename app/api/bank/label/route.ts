import { z } from "zod";

import { applyLabel, type Label } from "@/lib/bank/ingest";
import { createSupabaseBankStore } from "@/lib/bank/store";
import { newTransactionId } from "@/lib/finance/ids";
import { logError } from "@/lib/log";
import { fail, readBody, requireOwner } from "@/lib/web/api";

const labelBody = z.object({
  messageId: z.string().uuid(),
  action: z.enum(["category", "refund", "pass_through", "transfer", "skip"]),
  category: z.string().trim().min(1).max(40).optional(),
  description: z.string().trim().max(200).optional(),
  person: z.string().trim().max(120).optional(),
  includedFee: z.string().trim().max(20).optional(),
});

/** Labels a held bank payment from the website, the same way a Telegram button does. */
export async function POST(request: Request): Promise<Response> {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  const body = await readBody(request, labelBody);
  if (body instanceof Response) return body;
  if ((body.action === "category" || body.action === "refund") && !body.category) return fail("Pick a category.", 400);

  const label: Label =
    body.action === "category"
      ? { kind: "category", category: body.category ?? "", description: body.description ?? null, includedFee: body.includedFee ?? null }
      : body.action === "refund"
        ? { kind: "refund", category: body.category ?? "", description: body.description ?? null }
        : body.action === "pass_through"
          ? { kind: "pass_through", person: body.person ?? null, note: body.description ?? null }
          : { kind: body.action };
  try {
    const result = await applyLabel(
      { bank: createSupabaseBankStore(owner.settings.supabase), ledger: owner.store, now: new Date(), createId: newTransactionId },
      owner.profile,
      body.messageId,
      label,
    );
    if (!result.ok) return fail(result.text, 409);
    return Response.json({ ok: true, text: result.text });
  } catch (error) {
    logError("bank_label", error);
    return fail("That payment could not be filed.", 500);
  }
}
