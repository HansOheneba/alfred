import { parseAccountsReadQuery, projectAccountsReadView, AccountsReadViewError, type AccountsReadQuery } from "@/lib/finance/accounting/read-view";
import { loadAccountingReadModel, saveAccountingAction } from "@/lib/finance/accounting/persisted-store";
import { accountingActionSchema, MAX_ACCOUNTING_COMMAND_BYTES } from "@/lib/finance/accounting/schema";
import { actionFingerprint } from "@/lib/finance/accounting/reducer";
import { AccountingError, type AccountingAction } from "@/lib/finance/accounting/types";
import { requireOwner } from "@/lib/web/api";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const unconfirmed = () => json({ ok: false, code: "unconfirmed", text: "The save could not be confirmed. It may have completed. Reload the latest records before making another change." }, 500);
function failure(error: unknown) {
  if (error instanceof AccountsReadViewError) return json({ ok: false, text: error.message }, error.status);
  if (error instanceof AccountingError) {
    if (error.code === "ownership") return json({ ok: false, text: "Those financial records are unavailable in your account." }, 403);
    if (error.code === "stale" || error.code === "conflict") return json({ ok: false, text: "Financial records or source evidence changed. Reload the latest account view." }, 409);
    return json({ ok: false, text: "Check the financial action and try again." }, 400);
  }
  return json({ ok: false, text: "The financial records could not be loaded. Try again shortly." }, 500);
}
function selection(request: Request, defaultCurrency: string): AccountsReadQuery {
  const params = new URL(request.url).searchParams;
  if (!params.has("currency")) params.set("currency", defaultCurrency);
  return parseAccountsReadQuery(params);
}

export async function GET(request: Request) {
  try {
    const owner = await requireOwner();
    if (owner instanceof Response) { owner.headers.set("Cache-Control", "no-store"); return owner; }
    const query = selection(request, owner.profile.currency);
    const result = await loadAccountingReadModel(owner.settings.supabase, owner.profile.profileId);
    if (result.state.ownerId !== owner.profile.profileId) throw new AccountsReadViewError("Those financial records are unavailable in your account.", 403);
    return json({ ok: true, view: projectAccountsReadView(result, query) });
  } catch (error) { return failure(error); }
}

async function readAction(request: Request): Promise<AccountingAction | Response> {
  if (Number(request.headers.get("content-length")) > MAX_ACCOUNTING_COMMAND_BYTES) return json({ ok: false, text: "Financial request is too large." }, 413);
  const reader = request.body?.getReader();
  if (!reader) return json({ ok: false, text: "A financial action is required." }, 400);
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_ACCOUNTING_COMMAND_BYTES) { await reader.cancel(); return json({ ok: false, text: "Financial request is too large." }, 413); }
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const parsed = accountingActionSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success ? parsed.data : json({ ok: false, text: "Check the financial action and try again." }, 400);
  } catch { return json({ ok: false, text: "That financial request could not be read." }, 400); }
  finally { reader.releaseLock(); }
}

export async function POST(request: Request) {
  try {
    const owner = await requireOwner();
    if (owner instanceof Response) { owner.headers.set("Cache-Control", "no-store"); return owner; }
    // A browser holding another session's read view must not apply its command to
    // this session's ledger, even when IDs and revisions happen to overlap.
    if (request.headers.get("x-alfred-owner") !== owner.profile.profileId) {
      return json({ ok: false, text: "Your signed-in account changed. Reload Accounts before making another change." }, 403);
    }
    // Selection is validated before writing. The command's revision/fingerprint guard the write;
    // old display cursors are never compared to the newly acknowledged revision.
    const { expectedRevision: _revision, expectedSourceVersion: _source, ...query } = selection(request, owner.profile.currency);
    void _revision; void _source;
    const action = await readAction(request);
    if (action instanceof Response) return action;
    const result = await saveAccountingAction(owner.settings.supabase, owner.profile.profileId, action);
    if (result.availability !== "ready") return json({ ok: false, text: "Account storage is not set up yet. No financial change was made." }, 503);
    const last = result.state.audit.at(-1);
    if (result.state.ownerId !== owner.profile.profileId || result.state.revision !== action.expectedRevision + 1
      || last?.requestId !== action.requestId || last.revision !== result.state.revision || last.actionFingerprint !== actionFingerprint(action)) return unconfirmed();
    // A projection failure after a confirmed write must never look like a rejected/retryable write.
    try { return json({ ok: true, ack: { ownerId: result.state.ownerId, revision: result.state.revision, requestId: last.requestId }, view: projectAccountsReadView(result, query) }); }
    catch { return unconfirmed(); }
  } catch (error) { return failure(error); }
}
