import { z } from "zod";

import { requireOwner } from "@/lib/web/api";
import { displayedOwnerMatches, notificationJSON, privateJSON, sameOrigin } from "@/lib/notifications/http";
import { PushFailure, pushConfiguration, sendWebPush, type PushSubscriptionRecord } from "@/lib/notifications/push";
import { DbRateLimiter } from "@/lib/security/db-rate-limit";
import { query } from "@/lib/supabase/connection";

export const maxDuration = 30;

const body = z.object({ deviceId: z.string().uuid() }).strict();
const cooldownSeconds = 30;

/** An explicit transport diagnostic for one linked browser. It never enables a
 * preference, recovers payments, or retries an uncertain provider request. */
export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) {
    return privateJSON({ ok: false, text: "Use the signed-in Alfred page to test this browser." }, 403);
  }
  try {
    const owner = await requireOwner();
    if (owner instanceof Response) {
      owner.headers.set("cache-control", "private, no-store");
      owner.headers.set("vary", "Cookie, Origin");
      return owner;
    }
    if (!displayedOwnerMatches(request, owner.profile.profileId)) {
      return privateJSON({ ok: false, text: "Your account changed. Reload Alfred before testing notifications." }, 409);
    }
    let input: z.infer<typeof body>;
    try {
      input = body.parse(await notificationJSON(request));
    } catch {
      return privateJSON({ ok: false, text: "Choose the browser linked to this Alfred account." }, 400);
    }
    const configuration = pushConfiguration().config;
    if (!configuration || process.env.ALFRED_PUSH_DELIVERY_ENABLED !== "true") {
      return privateJSON({ ok: false, status: "unavailable", text: "Notification delivery is not configured and enabled on the server." }, 503);
    }
    const [device] = await query<{ id: string; subscription: PushSubscriptionRecord }>(owner.settings.supabase,
      `select id::text,subscription from public.push_subscriptions
       where owner_id=$1::uuid and id=$2::uuid and (expires_at is null or expires_at>now())`,
      [owner.profile.profileId, input.deviceId]);
    if (!device) {
      return privateJSON({ ok: false, status: "unavailable", text: "This browser is not currently linked to this Alfred account. Reconnect it before testing." }, 404);
    }
    // The database claim survives concurrent requests, process restarts and
    // uncertain delivery. A new explicit click is allowed after the cooldown.
    // PostgreSQL's canonical device ID keeps UUID case variants in one bucket.
    const allowed = await new DbRateLimiter(owner.settings.supabase, 1, cooldownSeconds * 1000)
      .allow(`notification-test:${owner.profile.profileId}:${device.id}`, Date.now());
    if (!allowed) {
      const response = privateJSON({ ok: false, status: "throttled", retryAfterSeconds: cooldownSeconds,
        text: "Wait 30 seconds before sending another test to this browser." }, 429);
      response.headers.set("retry-after", String(cooldownSeconds));
      return response;
    }
    try {
      const response = await sendWebPush(device.subscription, configuration, "test");
      if (response.status >= 200 && response.status < 300) {
        return privateJSON({ ok: true, status: "accepted",
          text: "The push provider accepted the test. This does not confirm that your browser displayed it." });
      }
      return privateJSON({ ok: false, status: "rejected", text: response.status === 404 || response.status === 410
        ? "The push provider no longer recognizes this browser connection. Reconnect it before testing again."
        : "The push provider did not accept the test. No automatic retry was scheduled." }, 502);
    } catch (error) {
      if (error instanceof PushFailure && error.stage !== "connection") {
        return privateJSON({ ok: false, status: "unavailable",
          text: "The server could not prepare the test notification. No notification was sent." }, 503);
      }
      return privateJSON({ ok: true, status: "unconfirmed",
        text: "The test may have been sent, but its result could not be confirmed. It will not be automatically retried." }, 202);
    }
  } catch {
    return privateJSON({ ok: false, status: "unavailable", text: "The browser test is unavailable. Nothing was automatically retried." }, 503);
  }
}
