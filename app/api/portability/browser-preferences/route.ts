import { cookies } from "next/headers";

import { boundedBody, PRIVATE_HEADERS, requireSameOrigin } from "@/lib/portability/http";
import { requireOwner } from "@/lib/web/api";
import { HOME_COOKIE, readHome } from "@/lib/web/home";

export async function GET() {
  const owner = await requireOwner(); if (owner instanceof Response) return owner;
  const home = readHome((await cookies()).get(HOME_COOKIE)?.value);
  return Response.json({ ok: true, home }, { headers: PRIVATE_HEADERS });
}

export async function POST(request: Request) {
  const originError = requireSameOrigin(request); if (originError) return originError;
  const owner = await requireOwner(); if (owner instanceof Response) return owner;
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(await boundedBody(request, 1024))); }
  catch { return Response.json({ ok: false, text: "The home-screen preference could not be read." }, { status: 400, headers: PRIVATE_HEADERS }); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join(",") !== "expectedHome,home") return Response.json({ ok: false, text: "Only the home-screen preference can be changed here." }, { status: 400, headers: PRIVATE_HEADERS });
  const { home, expectedHome } = body as { home: unknown; expectedHome: unknown };
  if (typeof home !== "string" || !["chat", "overview"].includes(home) || typeof expectedHome !== "string" || !["chat", "overview"].includes(expectedHome)) return Response.json({ ok: false, text: "Choose Chat or Overview as the home screen." }, { status: 400, headers: PRIVATE_HEADERS });
  const cookieStore = await cookies();
  if (readHome(cookieStore.get(HOME_COOKIE)?.value) !== expectedHome) return Response.json({ ok: false, text: "This browser's home screen changed after preview. No preference was overwritten." }, { status: 409, headers: PRIVATE_HEADERS });
  cookieStore.set(HOME_COOKIE, String(home), { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax", secure: process.env.NODE_ENV === "production", httpOnly: true });
  return Response.json({ ok: true, home }, { headers: PRIVATE_HEADERS });
}
