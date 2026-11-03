import { connection } from "next/server";

import { logError } from "@/lib/log";
import { requireOwner } from "@/lib/web/api";
import { financeLooksEmpty } from "@/lib/web/finance-empty";

/** Recheck setup guidance after a write without fetching or projecting the financial summary. */
export async function GET(): Promise<Response> {
  await connection();
  try {
    const owner = await requireOwner();
    if (owner instanceof Response) {
      owner.headers.set("cache-control", "no-store");
      return owner;
    }
    const financialsEmpty = await financeLooksEmpty(owner.settings.supabase, owner.profile.profileId);
    return Response.json({ ok: true, ownerId: owner.profile.profileId, financialsEmpty }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    logError("chat_empty_status", error);
    return Response.json({ ok: false, text: "Your account status could not be checked. Try again." }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
