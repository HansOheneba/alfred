import { z } from "zod";

import { createSupabaseBillStore, upcomingBills } from "@/lib/finance/bills";
import { zonedYmd } from "@/lib/finance/dates";
import { canonicalizeAmount } from "@/lib/finance/money";
import { amountSchema, isoDateSchema } from "@/lib/finance/schemas";
import { logError } from "@/lib/log";
import { fail, readBody, requireOwner } from "@/lib/web/api";

const saveBody = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"),
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(80),
    nextDate: isoDateSchema,
    amount: z.string().trim().nullable().optional(),
    cadence: z.enum(["once", "weekly", "monthly", "yearly"]),
    active: z.boolean().optional(),
  }),
  z.object({
    action: z.enum(["pause", "resume"]),
    id: z.string().uuid(),
  }),
  z.object({
    action: z.literal("delete"),
    id: z.string().uuid(),
  }),
]);

export async function POST(request: Request): Promise<Response> {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  const body = await readBody(request, saveBody);
  if (body instanceof Response) return body;

  const store = createSupabaseBillStore(owner.settings.supabase);
  const userId = owner.profile.profileId;
  const today = zonedYmd(new Date(), owner.profile.timezone);

  try {
    if (body.action === "save") {
      let amount: string | null = null;
      if (body.amount != null && body.amount !== "") {
        const canonical = canonicalizeAmount(body.amount);
        if (!canonical || !amountSchema.safeParse(canonical).success) {
          return fail("Enter a positive amount with up to two decimals, or leave it blank for a variable bill.", 400);
        }
        amount = canonical;
      }
      await store.save(userId, {
        id: body.id,
        name: body.name,
        nextDate: body.nextDate,
        amount,
        currency: owner.profile.currency,
        cadence: body.cadence,
        active: body.active ?? true,
      });
    } else if (body.action === "pause" || body.action === "resume") {
      await store.setActive(userId, body.id, body.action === "resume");
    } else {
      await store.remove(userId, body.id);
    }
    const bills = await store.list(userId);
    return Response.json({
      ok: true,
      bills,
      upcoming: upcomingBills(bills, today),
    });
  } catch (error) {
    logError("bills_api", error);
    return fail("That bill could not be saved.", 500);
  }
}
