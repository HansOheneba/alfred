import { AccountingError } from "@/lib/finance/accounting/types";
import { PortabilityUnavailable } from "./service";

export const PRIVATE_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
export function portabilityFailure(error: unknown) {
  if (error instanceof PortabilityUnavailable) return Response.json({ ok: false, text: error.message }, { status: 503, headers: PRIVATE_HEADERS });
  if (error instanceof AccountingError) return Response.json({ ok: false, text: error.message, code: error.code }, { status: error.code === "ownership" ? 403 : error.code === "not_found" ? 404 : ["stale", "conflict"].includes(error.code) ? 409 : 400, headers: PRIVATE_HEADERS });
  // Archive failures contain no user record values, only validation context.
  if (error instanceof Error && (error.name === "PortabilityError" || error.name === "ArchiveError" || error.message.startsWith("Invalid finance archive:"))) return Response.json({ ok: false, text: error.message }, { status: 400, headers: PRIVATE_HEADERS });
  // The database may have committed before its response was interrupted.
  return Response.json({ ok: false, text: "The result could not be confirmed. Check Previous imports before trying again. Retrying the same import will not add duplicates." }, { status: 500, headers: PRIVATE_HEADERS });
}
export function requireSameOrigin(request: Request): Response | null {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return Response.json({ ok: false, text: "Open data portability from this app." }, { status: 403, headers: PRIVATE_HEADERS });
  return null;
}
export async function boundedBody(request: Request, limit: number): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length")) > limit) throw new AccountingError("The uploaded archive is too large.");
  const reader = request.body?.getReader(); if (!reader) throw new AccountingError("Choose a finance ZIP archive.");
  const chunks: Uint8Array[] = []; let total = 0;
  while (true) {
    const item = await reader.read(); if (item.done) break;
    total += item.value.byteLength;
    if (total > limit) { await reader.cancel(); throw new AccountingError("The uploaded archive is too large."); }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
export async function readIdentifier(request: Request, key: "previewId" | "receiptId") {
  const bytes = await boundedBody(request, 1024);
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new AccountingError("The import request could not be read."); }
  if (!parsed || typeof parsed !== "object" || Object.keys(parsed).length !== 1 || typeof parsed[key] !== "string" || !/^[a-f0-9-]{36}$/.test(parsed[key])) throw new AccountingError("A valid import receipt or preview is required.");
  return parsed[key];
}
