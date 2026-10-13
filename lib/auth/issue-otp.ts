import { randomBytes } from "node:crypto";

import type { GenerateLinkParams, GenerateLinkResponse } from "@supabase/auth-js";

export type OtpMode = "sign-in" | "sign-up";
export type OtpVerifyType = "magiclink" | "signup";

type IssuedOtp = {
  ok: true;
  code: string;
  verifyType: OtpVerifyType;
};

type OtpFailure = {
  ok: false;
  text: string;
};

export function publicOtpError(mode: OtpMode, message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("rate limit")) return "Wait a few minutes before requesting another code.";
  if (mode === "sign-up" && (lower.includes("already") || lower.includes("registered"))) {
    return "That email already has an account. Sign in instead.";
  }
  if (mode === "sign-in" && (lower.includes("not found") || lower.includes("unable to find"))) {
    return "No Alfred account uses that email.";
  }
  return "Alfred could not send that code.";
}

export async function createEmailOtp(
  mode: OtpMode,
  email: string,
  generate: (params: GenerateLinkParams) => Promise<GenerateLinkResponse>,
): Promise<IssuedOtp | OtpFailure> {
  const first = await generate(linkParams(mode, email));
  if (!first.error && first.data.properties.email_otp) {
    return issued(first.data.properties.email_otp, first.data.properties.verification_type);
  }

  const firstMessage = first.error?.message ?? "Alfred could not create a code.";
  if (mode !== "sign-up" || !isExistingAccount(firstMessage)) {
    return { ok: false, text: publicOtpError(mode, firstMessage) };
  }

  const second = await generate(linkParams("sign-in", email));
  if (second.error || !second.data.properties.email_otp) {
    return { ok: false, text: publicOtpError("sign-up", second.error?.message ?? firstMessage) };
  }
  return issued(second.data.properties.email_otp, second.data.properties.verification_type);
}

function linkParams(mode: OtpMode, email: string): GenerateLinkParams {
  if (mode === "sign-up") {
    return {
      type: "signup",
      email,
      password: `A1!${randomBytes(24).toString("base64url")}`,
    };
  }
  return { type: "magiclink", email };
}

function issued(code: string, verificationType: string): IssuedOtp | OtpFailure {
  if (!/^\d{6,8}$/.test(code)) return { ok: false, text: "Alfred could not send that code." };
  if (verificationType !== "magiclink" && verificationType !== "signup") {
    return { ok: false, text: "Alfred could not send that code." };
  }
  return { ok: true, code, verifyType: verificationType };
}

function isExistingAccount(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("already") || lower.includes("registered");
}
