import { z } from "zod";

import { normalizeCategory } from "@/lib/finance/categories";
import { isSaneTransactionDate, zonedYmd } from "@/lib/finance/dates";
import { newTransactionId } from "@/lib/finance/ids";
import { amountSchema, isoDateSchema } from "@/lib/finance/schemas";
import { canonicalizeAmount, toMinor } from "@/lib/finance/money";
import { logError } from "@/lib/log";
import { fail, readBody, requireOwner } from "@/lib/web/api";

const editBody = z.object({
  transactionId: z.string().uuid(),
  changes: z
    .object({
      amount: z.string().optional(),
      category: z.string().trim().min(1).max(40).optional(),
      description: z.string().trim().min(1).max(200).optional(),
      date: isoDateSchema.optional(),
      transactionType: z.enum(["income", "expense"]).optional(),
      includedFee: z.string().optional(),
    })
    .refine((changes) => Object.values(changes).some((value) => value != null), "Change at least one field."),
});

const deleteBody = z.object({ transactionId: z.string().uuid() });

export async function PATCH(request: Request): Promise<Response> {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  const body = await readBody(request, editBody);
  if (body instanceof Response) return body;

  try {
    const userId = owner.profile.profileId;
    const target = (await owner.store.listTransactions(userId)).find(
      (item) => item.transactionId === body.transactionId && item.status === "active",
    );
    if (!target) return fail("That transaction isn't available.", 404);

    const { changes } = body;
    const baseAmount = changes.amount == null ? target.amount : canonicalizeAmount(changes.amount);
    if (!baseAmount || !amountSchema.safeParse(baseAmount).success) {
      return fail("Enter a positive amount with up to two decimals.", 400);
    }
    const splitFee = changes.includedFee ? canonicalizeAmount(changes.includedFee) : null;
    if (changes.includedFee && (!splitFee || !amountSchema.safeParse(splitFee).success)) {
      return fail("Enter a positive fee amount with up to two decimals.", 400);
    }
    const type = changes.transactionType ?? target.type;
    if (splitFee) {
      if (type !== "expense" || target.category === "Fees") return fail("Only an expense outside Fees can have a fee split out.", 400);
      if (toMinor(splitFee) >= toMinor(baseAmount)) return fail("The included fee must be less than the payment amount.", 400);
    }
    const category =
      changes.category || changes.transactionType ? normalizeCategory(changes.category ?? target.category, type) : undefined;
    if ((changes.category || changes.transactionType) && !category) return fail("Pick a category that fits that type.", 400);
    const today = zonedYmd(new Date(), owner.profile.timezone);
    if (changes.date && !isSaneTransactionDate(changes.date, today)) return fail("That date isn't one Alfred can store.", 400);

    const principalAmount = splitFee ? ((toMinor(baseAmount) - toMinor(splitFee)) / 100).toFixed(2) : changes.amount == null ? undefined : baseAmount;
    const updated = await owner.store.updateTransaction(userId, target.transactionId, {
      amount: principalAmount,
      category: category ?? undefined,
      description: changes.description,
      date: changes.date,
      transactionType: changes.transactionType,
    });
    if (splitFee) {
      const now = new Date().toISOString();
      await owner.store.appendTransaction({
        transactionId: newTransactionId(),
        createdAt: now,
        transactionDate: changes.date ?? target.transactionDate,
        userId,
        type: "expense",
        amount: splitFee,
        currency: target.currency,
        category: "Fees",
        description: `Fees · ${(changes.description ?? target.description).slice(0, 180)}`,
        paymentMethod: target.paymentMethod,
        notes: "",
        status: "active",
        updatedAt: now,
        sourceUpdateId: `split-fee:${target.transactionId}:${now}`,
      });
    }
    return Response.json({ ok: true, transaction: updated });
  } catch (error) {
    logError("transaction_edit", error);
    return fail("That change could not be saved.", 500);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  const body = await readBody(request, deleteBody);
  if (body instanceof Response) return body;

  try {
    const userId = owner.profile.profileId;
    const target = (await owner.store.listTransactions(userId)).find(
      (item) => item.transactionId === body.transactionId && item.status === "active",
    );
    if (!target) return fail("That transaction isn't available.", 404);
    // Deleted rows stay in the ledger and drop out of totals, as in chat.
    await owner.store.updateTransaction(userId, target.transactionId, { status: "deleted" });
    return Response.json({ ok: true });
  } catch (error) {
    logError("transaction_delete", error);
    return fail("That transaction could not be removed.", 500);
  }
}
