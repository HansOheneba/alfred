import { z } from "zod";

import { zonedYmd } from "@/lib/finance/dates";
import { currencySchema, nonNegativeAmountSchema, amountSchema, isoDateSchema } from "@/lib/finance/schemas";
import { canonicalizeAmount } from "@/lib/finance/money";
import { loadPortfolio } from "@/lib/investments/actions";
import { createSupabaseInvestmentStore, INVESTMENT_KINDS } from "@/lib/investments/store";
import { logError } from "@/lib/log";
import { fail, readBody, requireOwner } from "@/lib/web/api";

const amount = (schema: typeof amountSchema) => z.preprocess((value) => (value === "" || value == null ? null : canonicalizeAmount(String(value).replace(/,/g, ""), { allowZero: true }) ?? value), schema.nullable());

const body = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add"),
    name: z.string().trim().min(1, "Give it a name.").max(80),
    kind: z.enum(INVESTMENT_KINDS),
    currency: currencySchema,
    value: amount(nonNegativeAmountSchema).optional(),
    principal: amount(amountSchema).optional(),
    rate: z.number().min(0).max(200).nullable().optional(),
    maturesOn: isoDateSchema.nullable().optional(),
  }),
  z.object({ op: z.literal("value"), id: z.uuid(), value: amount(nonNegativeAmountSchema) }),
  z.object({ op: z.literal("close"), id: z.uuid() }),
]);

/** Adds an investment, records a new value, or closes one, from the Investments page. Returns the fresh portfolio. */
export async function POST(request: Request): Promise<Response> {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  const input = await readBody(request, body);
  if (input instanceof Response) return input;
  const store = createSupabaseInvestmentStore(owner.settings.supabase);
  const ownerId = owner.profile.profileId;
  const today = zonedYmd(new Date(), owner.profile.timezone);
  try {
    if (input.op === "add") {
      const fixed = input.kind === "tbill" || input.kind === "fixed_deposit" || input.kind === "bond";
      const investment = await store.create(ownerId, {
        name: input.name,
        kind: input.kind,
        currency: input.currency,
        principal: fixed ? input.principal ?? null : null,
        investedBefore: fixed && input.principal ? input.principal : undefined,
        rate: fixed ? input.rate ?? null : null,
        startedOn: fixed && input.principal ? today : null,
        maturesOn: fixed ? input.maturesOn ?? null : null,
      });
      if (input.value != null) await store.addValue(ownerId, investment.id, input.value, new Date().toISOString(), "reported");
    } else {
      const known = (await store.list(ownerId)).find((item) => item.id === input.id);
      if (!known) return fail("That investment isn't there anymore.", 404);
      if (input.op === "value") {
        if (input.value == null) return fail("Enter what it's worth now.", 400);
        await store.addValue(ownerId, known.id, input.value, new Date().toISOString(), "reported");
      } else {
        await store.update(ownerId, known.id, { status: "closed" });
      }
    }
    return Response.json({ ok: true, portfolio: await loadPortfolio(store, ownerId, today, { fetchMissing: true }) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/duplicate key|unique/i.test(message)) return fail("You already have an investment with that name.", 400);
    logError("investments_save", error);
    return fail("That couldn't be saved. Try again.", 500);
  }
}
