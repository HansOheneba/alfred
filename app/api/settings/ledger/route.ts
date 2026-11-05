import { connection } from "next/server";
import { requireOwner } from "@/lib/web/api";
import { loadSettingsBank, loadSettingsBudgets, loadSettingsGoals } from "@/lib/web/secondary-read-models";
import { DurableDisplayUpdating } from "@/lib/finance/accounting/durable-read";

const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
export async function GET(request?: Request) {
  await connection();
  try {
    const owner = await requireOwner();
    if (owner instanceof Response) return new Response(owner.body, { status: owner.status, headers: { ...Object.fromEntries(owner.headers), ...headers } });
    const section = request ? new URL(request.url).searchParams.get("section") : null;
    if (section !== "budgets" && section !== "goals" && section !== "bank") return Response.json({ ok: false, text: "Choose the settings section to load." }, { status: 400, headers });
    const load = section === "budgets" ? loadSettingsBudgets : section === "goals" ? loadSettingsGoals : loadSettingsBank;
    return Response.json({ ok: true, ownerId: owner.profile.profileId, [section]: await load(owner.profile, owner.settings) }, { headers });
  } catch (error) {
    if(error instanceof DurableDisplayUpdating)return Response.json({ok:false,updating:true,text:error.message},{status:202,headers});
    return Response.json({ ok: false, text: "Your financial records could not be loaded. Please try again." }, { status: 500, headers });
  }
}
