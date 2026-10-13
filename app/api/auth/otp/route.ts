import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { createEmailOtp, type OtpVerifyType } from "@/lib/auth/issue-otp";
import { otpEmail, readResendConfig, sendResendEmail } from "@/lib/email/resend";
import { getDatabaseSettings } from "@/lib/env";
import { logError } from "@/lib/log";
import { DbRateLimiter } from "@/lib/security/db-rate-limit";

const requestBody = z.object({
  email: z.string().trim().toLowerCase().max(320),
  mode: z.enum(["sign-in", "sign-up"]),
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WINDOW_MS = 15 * 60 * 1000;

export async function POST(request: Request): Promise<Response> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ ok: false, text: "That sign-in request could not be read." }, { status: 400 });
  }
  const parsed = requestBody.safeParse(json);
  if (!parsed.success || !EMAIL.test(parsed.data.email)) {
    return Response.json({ ok: false, text: "Enter a valid email address." }, { status: 400 });
  }

  const resend = readResendConfig();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim();
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!resend || !url || !serviceRole) {
    return Response.json({ ok: false, text: "Email sign-in is not configured." }, { status: 503 });
  }

  try {
    const limiter = new DbRateLimiter(getDatabaseSettings(), 5, WINDOW_MS);
    const allowed = await limiter.allow(`otp:${parsed.data.email}`, Date.now());
    if (!allowed) {
      return Response.json({ ok: false, text: "Wait a few minutes before requesting another code." }, { status: 429 });
    }
  } catch (error) {
    logError("otp_rate_limit", error);
    return Response.json({ ok: false, text: "Alfred could not send that code." }, { status: 500 });
  }

  const admin = createClient(url, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  let issued: Awaited<ReturnType<typeof createEmailOtp>>;
  try {
    issued = await createEmailOtp(parsed.data.mode, parsed.data.email, (params) => admin.auth.admin.generateLink(params));
  } catch (error) {
    logError("otp_generate", error);
    return Response.json({ ok: false, text: "Alfred could not send that code." }, { status: 500 });
  }
  if (!issued.ok) return Response.json(issued, { status: 400 });

  const message = otpEmail(issued.code);
  const sent = await sendResendEmail(resend, { to: parsed.data.email, ...message });
  if (!sent.ok) {
    logError("otp_send", new Error(sent.message));
    return Response.json({ ok: false, text: "Alfred could not send that code." }, { status: 502 });
  }

  const verifyType: OtpVerifyType = issued.verifyType;
  return Response.json({ ok: true, verifyType });
}
