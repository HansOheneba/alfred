import { collectorAccount } from "@/lib/bank/collector-account";
import { getDatabaseSettings } from "@/lib/env";

function answer(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "private, no-store", pragma: "no-cache", vary: "Authorization", "x-content-type-options": "nosniff" } });
}

/** Existing-key identity check only. No SMS, key creation or last-used mutation. */
export async function GET(request: Request): Promise<Response> {
  if (new URL(request.url).search || request.body) return answer({ ok: false, text: "Use the account connection check without message data." }, 400);
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer (alf_[A-Za-z0-9_-]{20,64})$/i.exec(authorization);
  if (!match) return answer({ ok: false, text: "A valid forwarding key is required." }, 401);
  try {
    const account = await collectorAccount(getDatabaseSettings(), match[1]);
    return account ? answer({ ok: true, identityProtocol: 1, account }) : answer({ ok: false, text: "This account connection could not be verified." }, 401);
  } catch {
    // Neither database errors nor credentials/identity belong in logs or errors.
    return answer({ ok: false, text: "The account connection could not be checked. Try again later." }, 503);
  }
}
