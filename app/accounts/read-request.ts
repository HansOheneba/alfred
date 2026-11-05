import type { AccountingAction } from "@/lib/finance/accounting/types";
import type { AccountsReadView } from "@/lib/finance/accounting/read-view";
import { assertMutationsAvailable, requireMutationRecovery } from "@/app/components/mutation-request";

export class AccountsViewRequestError extends Error {
  constructor(message: string, readonly status?: number, readonly unconfirmed = false) { super(message); this.name = "AccountsViewRequestError"; }
}
export const ACCOUNTS_VIEW_TIMEOUT_MS = 20_000;
const uncertain = "The save could not be confirmed. It may have completed. Reload the latest records before making another change.";

function isView(value: unknown, ownerId: string): value is AccountsReadView {
  if (!value || typeof value !== "object") return false;
  const view = value as AccountsReadView;
  const movement = (value: unknown): boolean => Boolean(value && typeof value === "object" && (value as { ownerId?: unknown }).ownerId === ownerId && typeof (value as { id?: unknown }).id === "string" && typeof (value as { sourceFingerprint?: unknown }).sourceFingerprint === "string" && !("sourceText" in value));
  const nullableMovement = (value: unknown) => value === null || movement(value);
  const sections = ["activity", "attention", "movement", "similar", "targets", "snapshots", "transfers", "settlements", "returns", "evidence", "settlement-plan"];
  const rowsOwned = Array.isArray(view.page?.rows) && view.page.rows.every(row => {
    if (["activity", "attention", "movement", "similar", "targets"].includes(view.page.section)) return movement(row);
    if (!row || typeof row !== "object") return false;
    if (view.page.section === "transfers") return "outgoing" in row && "incoming" in row && nullableMovement(row.outgoing) && nullableMovement(row.incoming);
    if (view.page.section === "settlements") return "original" in row && nullableMovement(row.original);
    if (view.page.section === "returns") return "movement" in row && nullableMovement(row.movement);
    return true;
  });
  return view.kind === "accounts-read" && view.ownerId === ownerId && Number.isSafeInteger(view.revision) && view.revision >= 0
    && (view.sourceVersion === null || typeof view.sourceVersion === "string") && ["ready", "migration-required"].includes(view.availability)
    && Array.isArray(view.accounts) && Array.isArray(view.audit) && view.audit.length <= 50 && !!view.balances && Array.isArray(view.balances.accounts)
    && !!view.counts && !!view.attentionCounts && !!view.facets && !!view.page && Array.isArray(view.page.rows) && view.page.rows.length <= 25
    && view.page.pageSize === 25 && Number.isSafeInteger(view.page.page) && view.page.page >= 0 && Number.isSafeInteger(view.page.total) && view.page.total >= view.page.rows.length && sections.includes(view.page.section) && rowsOwned;
}

/** Read DTOs never become editable AccountingState; commands retain original revisions and source references. */
export async function requestAccountsView({ ownerId, query = "", method = "GET", action, request = fetch, timeoutMs = ACCOUNTS_VIEW_TIMEOUT_MS }: {
  ownerId: string; query?: string | URLSearchParams; method?: "GET" | "POST"; action?: AccountingAction; request?: typeof fetch; timeoutMs?: number;
}): Promise<AccountsReadView> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const failure = method === "POST" ? uncertain : "Account records could not be loaded. Reload the latest records to try again.";
  try {
    if (method === "POST") assertMutationsAvailable();
    const operation = (async () => {
      const suffix = query.toString();
      const response = await request(`/api/accounts/view${suffix ? `?${suffix}` : ""}`, {
        method, cache: "no-store", credentials: "same-origin", signal: controller.signal,
        ...(method === "POST" ? { headers: { "Content-Type": "application/json", "x-alfred-owner": ownerId }, body: JSON.stringify(action) } : {}),
      });
      const body = await response.json();
      if (!response.ok || body?.ok !== true) throw new AccountsViewRequestError(typeof body?.text === "string" ? body.text : typeof body?.error === "string" ? body.error : failure, response.status, method === "POST" && (response.ok || response.status >= 500));
      if (!isView(body.view, ownerId)) throw new AccountsViewRequestError(failure, undefined, method === "POST");
      if (method === "POST" && (!action || body.ack?.ownerId !== ownerId || body.ack?.requestId !== action.requestId || body.ack?.revision !== action.expectedRevision + 1 || body.view.revision !== body.ack.revision)) throw new AccountsViewRequestError(uncertain, undefined, true);
      return body.view;
    })();
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new AccountsViewRequestError(failure, undefined, method === "POST")); controller.abort(); }, timeoutMs); });
    return await Promise.race([operation, deadline]);
  } catch (error) {
    const known = error instanceof AccountsViewRequestError ? error : new AccountsViewRequestError(failure, undefined, method === "POST");
    if (known.unconfirmed) requireMutationRecovery();
    throw known;
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
