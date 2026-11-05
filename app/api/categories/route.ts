import { readCategories } from "@/lib/finance/categories";
import { logError } from "@/lib/log";
import { fail, requireOwner } from "@/lib/web/api";

/** The signed-in owner's reusable categories; financial mutations stay in the confirmed chat flow. */
export async function GET(): Promise<Response> {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  try {
    const ownerId = owner.profile.profileId;
    const categories = (await readCategories(owner.store, ownerId)).filter(item => item.userId === ownerId);
    return Response.json({ ok: true, ownerId, categories }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    logError("category_list", error);
    return fail("Your categories could not be loaded.", 500);
  }
}
