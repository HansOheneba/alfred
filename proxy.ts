import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { automationPreviewBypassesAuth } from "@/lib/preview/access";
import { HOME_COOKIE, HOME_PATHS, readHome } from "@/lib/web/home";

export async function proxy(request: NextRequest) {
  // These three read-only fictional pages need no account session. Keep their
  // hosted previews free of auth refreshes while real routes retain this proxy.
  if (automationPreviewBypassesAuth(request.nextUrl.pathname, request.method, process.env)) return NextResponse.next();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !anonKey) return NextResponse.next({ request });

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });
  // getClaims verifies the asymmetric session JWT locally (keys are cached per
  // instance) and refreshes it when expired, so most requests skip an Auth round trip.
  const { data } = await supabase.auth.getClaims();
  if (data?.claims && request.nextUrl.pathname === "/" && request.method === "GET") {
    // The installed app starts at "/". Send signed-in people straight to their home
    // screen instead of rendering a sign-in gate that then redirects in the browser.
    const home = request.nextUrl.clone();
    home.pathname = HOME_PATHS[readHome(request.cookies.get(HOME_COOKIE)?.value)];
    const redirect = NextResponse.redirect(home);
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  }
  return response;
}

export const config = {
  // Skip static files, the service worker, and endpoints that authenticate with their own secrets.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sw.js|offline.html|manifest.webmanifest|api/telegram/webhook|api/cron|api/ingest|.*\\.(?:png|jpg|jpeg|svg|ico|webp|shortcut)$).*)",
  ],
};
