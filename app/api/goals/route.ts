import { z } from "zod";

import { newTransactionId } from "@/lib/finance/ids";
import { canonicalizeAmount } from "@/lib/finance/money";
import { amountSchema, isoDateSchema, nonNegativeAmountSchema } from "@/lib/finance/schemas";
import { logError } from "@/lib/log";
import { fail, readBody, requireOwner } from "@/lib/web/api";

const fields = {
  name: z.string().trim().min(1).max(80),
  targetAmount: z.string(),
  currentAmount: z.string(),
  targetDate: z.union([isoDateSchema, z.literal("")]),
};

const createBody = z.object(fields);
const updateBody = z.object({ goalId: z.string().min(8).max(80), status: z.enum(["active", "completed"]), ...fields });
const deleteBody = z.object({ goalId: z.string().min(8).max(80) });

function amounts(body: { targetAmount: string; currentAmount: string }) {
  const target = canonicalizeAmount(body.targetAmount);
  const current = canonicalizeAmount(body.currentAmount || "0", { allowZero: true });
  if (!target || !amountSchema.safeParse(target).success) return null;
  if (!current || !nonNegativeAmountSchema.safeParse(current).success) return null;
  return { target, current };
}

export async function POST(request: Request): Promise<Response> {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  const body = await readBody(request, createBody);
  if (body instanceof Response) return body;
  const money = amounts(body);
  if (!money) return fail("Enter a positive target and a saved amount of zero or more.", 400);

  try {
    const timestamp = new Date().toISOString();
    const goal = await owner.store.appendSavingsGoal({
      goalId: newTransactionId(),
      userId: owner.profile.profileId,
      name: body.name,
      targetAmount: money.target,
      currentAmount: money.current,
      currency: owner.profile.currency,
      targetDate: body.targetDate,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return Response.json({ ok: true, goal });
  } catch (error) {
    logError("goal_create", error);
    return fail("That goal could not be saved.", 500);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  const body = await readBody(request, updateBody);
  if (body instanceof Response) return body;
  const money = amounts(body);
  if (!money) return fail("Enter a positive target and a saved amount of zero or more.", 400);

  try {
    const userId = owner.profile.profileId;
    const goal = (await owner.store.listSavingsGoals(userId)).find((item) => item.goalId === body.goalId);
    if (!goal) return fail("That goal isn't available.", 404);
    const updated = await owner.store.updateSavingsGoal(userId, goal.goalId, {
      name: body.name,
      targetAmount: money.target,
      currentAmount: money.current,
      targetDate: body.targetDate,
      status: body.status,
    });
    return Response.json({ ok: true, goal: updated });
  } catch (error) {
    logError("goal_update", error);
    return fail("That goal could not be saved.", 500);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  const body = await readBody(request, deleteBody);
  if (body instanceof Response) return body;

  try {
    const userId = owner.profile.profileId;
    const goal = (await owner.store.listSavingsGoals(userId)).find((item) => item.goalId === body.goalId);
    if (!goal) return fail("That goal isn't available.", 404);
    await owner.store.updateSavingsGoal(userId, goal.goalId, { status: "deleted" });
    return Response.json({ ok: true });
  } catch (error) {
    logError("goal_delete", error);
    return fail("That goal could not be removed.", 500);
  }
}
