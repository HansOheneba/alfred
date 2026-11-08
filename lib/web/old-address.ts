import { NextResponse, type NextRequest } from "next/server";

import { DASHBOARD_URL } from "@/lib/config";

/** Where Alfred used to live. Phone relays, the Telegram webhook and installed shortcuts still call it. */
export const OLD_HOST = "alfred.hansopoku.com";

/**
 * Sends people who open the old address to the same page on the new one.
 * Only page visits move: the callers above don't follow redirects, so /api
 * keeps answering on the old address, as do the push workers, which the
 * proxy never sees and which existing notifications depend on.
 */
export function moveOffOldAddress(request: NextRequest): NextResponse | null {
  if (request.headers.get("host")?.toLowerCase() !== OLD_HOST) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const { pathname, search } = request.nextUrl;
  if (pathname === "/api" || pathname.startsWith("/api/")) return null;
  return NextResponse.redirect(`${DASHBOARD_URL}${pathname}${search}`, 307);
}
