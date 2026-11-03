import { connection } from "next/server";
import { logError } from "@/lib/log";
import { requireOwner } from "@/lib/web/api";
import { loadLedger } from "@/lib/web/ledger";

/** Optional conversation context. A failed summary must never hide the composer. */
export async function GET(): Promise<Response> {
  await connection();
  try {
    const owner = await requireOwner();
    if (owner instanceof Response) {
      owner.headers.set("cache-control", "no-store");
      return owner;
    }
    const ledger = await loadLedger(owner.profile, owner.settings);
    return Response.json({ ok: true, ownerId: owner.profile.profileId, ledger }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    logError("chat_context", error);
    return Response.json({ ok: false, text: "Your financial summary could not be loaded. You can keep chatting and try again." }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
