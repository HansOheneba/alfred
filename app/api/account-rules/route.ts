import { accountRuleCommandSchema, MAX_ACCOUNT_RULE_COMMAND_BYTES } from "@/lib/account-rules/schema";
import { loadAccountRules, saveAccountRuleCommand } from "@/lib/account-rules/store";
import { AccountRuleError } from "@/lib/account-rules/types";
import { requireOwner } from "@/lib/web/api";

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
function failure(error: unknown): Response {
  if (error instanceof AccountRuleError) return Response.json({ ok: false, text: error.message, code: error.code }, { status: error.code === "ownership" ? 403 : ["stale", "conflict"].includes(error.code) ? 409 : error.code === "not_found" ? 404 : 400, headers });
  return Response.json({ ok: false, text: "Account rules could not be saved or loaded. Try again shortly." }, { status: 500, headers });
}
export async function GET() {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  try { return Response.json({ ok: true, ...await loadAccountRules(owner.settings.supabase, owner.profile.profileId) }, { headers }); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  if (request.headers.get("origin") && request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ ok: false, text: "Open account rules from this app." }, { status: 403, headers });
  if (Number(request.headers.get("content-length")) > MAX_ACCOUNT_RULE_COMMAND_BYTES) return Response.json({ ok: false, text: "Account rule request is too large." }, { status: 413, headers });
  const reader = request.body?.getReader();
  if (!reader) return failure(new AccountRuleError("An account rule command is required."));
  try {
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_ACCOUNT_RULE_COMMAND_BYTES) { await reader.cancel(); return Response.json({ ok: false, text: "Account rule request is too large." }, { status: 413, headers }); }
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const parsed = accountRuleCommandSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    if (!parsed.success) return failure(new AccountRuleError(parsed.error.issues[0]?.message ?? "Check the account rule."));
    const result = await saveAccountRuleCommand(owner.settings.supabase, owner.profile.profileId, parsed.data);
    if (result.availability !== "ready") return Response.json({ ok: false, text: "The account-rules migration requires review and application before saving. No rule was changed.", ...result }, { status: 503, headers });
    return Response.json({ ok: true, ...result }, { headers });
  } catch (error) { return failure(error instanceof SyntaxError ? new AccountRuleError("That account rule request could not be read.") : error); }
}
