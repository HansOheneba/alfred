import { collectorAccount } from "@/lib/bank/collector-account";
import { collectorRequestAllowed, logCollectorRejection } from "@/lib/bank/collector-requests";
import { getDatabaseSettings } from "@/lib/env";

function answer(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "private, no-store", pragma: "no-cache", vary: "Authorization", "x-content-type-options": "nosniff" } });
}

/** Existing-key identity check. Only operational throttling is written; no SMS,
 * key creation, financial record or delivery/last-used mutation. */
export async function GET(request: Request): Promise<Response> {
  if (new URL(request.url).search || request.body) {
    logCollectorRejection("account", "invalid_request");
    return answer({ ok: false, text: "Use the account connection check without message data." }, 400);
  }
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer (alf_[A-Za-z0-9_-]{20,64})$/i.exec(authorization);
  try {
    const settings = getDatabaseSettings();
    if (!await collectorRequestAllowed(settings, request, match?.[1] ?? null)) {
      logCollectorRejection("account", "rate_limited");
      return answer({ ok: false, text: "Too many account checks. Try again shortly." }, 429);
    }
    if (!match) {
      logCollectorRejection("account", "missing_or_malformed_key");
      return answer({ ok: false, text: "A valid forwarding key is required." }, 401);
    }
    const account = await collectorAccount(settings, match[1]);
    if (!account) {
      logCollectorRejection("account", "invalid_key");
      return answer({ ok: false, text: "This account connection could not be verified." }, 401);
    }
    return answer({ ok: true, identityProtocol: 1, account });
  } catch {
    // Neither database errors nor credentials/identity belong in logs or errors.
    logCollectorRejection("account", "unavailable");
    return answer({ ok: false, text: "The account connection could not be checked. Try again later." }, 503);
  }
}
