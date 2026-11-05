import { z } from "zod";

import type { ChartQuery } from "@/lib/finance/charts";
import { chartQuerySchema, createSupabasePinStore, MAX_PINS } from "@/lib/finance/pins";
import { logError } from "@/lib/log";
import { fail, readBody, requireOwner } from "@/lib/web/api";

const addBody = z.object({ title: z.string().trim().min(1).max(120).regex(/^[^\p{Cc}]+$/u), query: chartQuerySchema });
const removeBody = z.object({ id: z.string().uuid() });

/** The same chart always stores the same way, so keeping it twice keeps it once. */
function canonical(query: ChartQuery): ChartQuery {
  const keys = ["measure", "by", "style", "compare", "category", "period", "month", "year", "startDate", "endDate"] as const;
  return Object.fromEntries(keys.flatMap((key) => (query[key] === null || query[key] === undefined ? [] : [[key, query[key]]]))) as ChartQuery;
}

/** Keeps a chart from chat on the signed-in owner's Overview. */
export async function POST(request: Request): Promise<Response> {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  const body = await readBody(request, addBody);
  if (body instanceof Response) return body;
  try {
    const pin = await createSupabasePinStore(owner.settings.supabase).add(owner.profile.profileId, body.title, canonical(body.query));
    if (!pin) return fail(`Your Overview already has ${MAX_PINS} charts. Remove one there first.`, 409);
    return Response.json({ ok: true, pin }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    logError("pin_add", error);
    return fail("That chart couldn't be added to your Overview.", 500);
  }
}

/** Takes a kept chart off the Overview. The books are unchanged. */
export async function DELETE(request: Request): Promise<Response> {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  const body = await readBody(request, removeBody);
  if (body instanceof Response) return body;
  try {
    const removed = await createSupabasePinStore(owner.settings.supabase).remove(owner.profile.profileId, body.id);
    return removed ? Response.json({ ok: true }) : fail("That chart is no longer on your Overview.", 404);
  } catch (error) {
    logError("pin_remove", error);
    return fail("That chart couldn't be removed.", 500);
  }
}
