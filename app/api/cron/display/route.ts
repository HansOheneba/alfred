import { timingSafeEqual } from "node:crypto";
import { getDatabaseSettings } from "@/lib/env";
import { displayWorkerEnabled, readDisplayWorkerStatus, runDisplayWorker } from "@/lib/finance/accounting/display-worker";

export const maxDuration = 60;
const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret ?? ""}`);
  if (!secret || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json({ ok: false }, 401);
  if (!displayWorkerEnabled()) return json({ ok: false, code: "worker_disabled" }, 503);
  try {
    const result = await runDisplayWorker(getDatabaseSettings(), { maxOwners: 1 });
    const status = await readDisplayWorkerStatus(getDatabaseSettings());
    const ok = result.failed === 0 && status.ready;
    return json({ ok, ...result, status }, ok ? 200 : 503);
  } catch {
    return json({ ok: false, code: "worker_unavailable" }, 503);
  }
}
