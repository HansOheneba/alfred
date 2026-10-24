import { z } from "zod";

import { normalizeCategory } from "@/lib/finance/categories";
import { newTransactionId } from "@/lib/finance/ids";
import { canonicalizeAmount } from "@/lib/finance/money";
import { amountSchema, yearMonthSchema } from "@/lib/finance/schemas";
import { logError } from "@/lib/log";
import { fail, readBody, requireOwner } from "@/lib/web/api";

const saveBody = z.object({
  category: z.string().trim().min(1).max(40),
  amount: z.string(),
  period: yearMonthSchema,
});

const deleteBody = z.object({ budgetId: z.string().min(8).max(80) });

export async function POST(request: Request): Promise<Response> {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  const body = await readBody(request, saveBody);
  if (body instanceof Response) return body;

  const category = normalizeCategory(body.category, "expense");
  if (!category) return fail("Pick one of the expense categories.", 400);
  const amount = canonicalizeAmount(body.amount);
  if (!amount || !amountSchema.safeParse(amount).success) return fail("Enter a positive amount with up to two decimals.", 400);

  try {
    const timestamp = new Date().toISOString();
    const budget = await owner.store.saveBudget({
      budgetId: newTransactionId(),
      userId: owner.profile.profileId,
      period: body.period,
      category,
      amount,
      currency: owner.profile.currency,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return Response.json({ ok: true, budget });
  } catch (error) {
    logError("budget_save", error);
    return fail("That budget could not be saved.", 500);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  const body = await readBody(request, deleteBody);
  if (body instanceof Response) return body;

  try {
    const removed = await owner.store.deleteBudget(owner.profile.profileId, body.budgetId);
    if (!removed) return fail("That budget isn't available.", 404);
    return Response.json({ ok: true });
  } catch (error) {
    logError("budget_delete", error);
    return fail("That budget could not be removed.", 500);
  }
}
