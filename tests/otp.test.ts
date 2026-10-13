import { describe, expect, it } from "vitest";

import { createEmailOtp, publicOtpError } from "@/lib/auth/issue-otp";
import { formatFromAddress, otpEmail, sendResendEmail } from "@/lib/email/resend";
import type { GenerateLinkParams, GenerateLinkResponse } from "@supabase/auth-js";

describe("otp email", () => {
  it("formats a bare address with the Alfred name", () => {
    expect(formatFromAddress(" alfred@example.com ")).toBe("Alfred <alfred@example.com>");
    expect(formatFromAddress("Alfred <alfred@example.com>")).toBe("Alfred <alfred@example.com>");
    expect(formatFromAddress("not an email")).toBeNull();
  });

  it("puts only the numeric code in the message", () => {
    const message = otpEmail("123456");
    expect(message.subject).toBe("Your Alfred code");
    expect(message.text).toContain("123456");
    expect(message.html).toContain("123456");
    expect(message.text).not.toContain("<");
  });

  it("sends through the Resend API and keeps the key in the header", async () => {
    let captured: { url: string; authorization: string; body: { from: string; to: string[] } } | undefined;
    const result = await sendResendEmail(
      { apiKey: "test-key", from: "Alfred <alfred@example.com>" },
      { to: "person@example.com", subject: "Your Alfred code", text: "code", html: "<p>code</p>" },
      (async (url, init) => {
        captured = {
          url: String(url),
          authorization: new Headers(init?.headers).get("authorization") ?? "",
          body: JSON.parse(String(init?.body)),
        };
        return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
      }) as typeof fetch,
    );
    expect(result).toEqual({ ok: true });
    expect(captured?.url).toBe("https://api.resend.com/emails");
    expect(captured?.authorization).toBe("Bearer test-key");
    expect(captured?.body.from).toBe("Alfred <alfred@example.com>");
    expect(captured?.body.to).toEqual(["person@example.com"]);
  });

  it("creates a sign-in code without a password", async () => {
    const calls: GenerateLinkParams[] = [];
    const issued = await createEmailOtp("sign-in", "person@example.com", async (params) => {
      calls.push(params);
      return link("654321", "magiclink");
    });
    expect(calls).toEqual([{ type: "magiclink", email: "person@example.com" }]);
    expect(issued).toEqual({ ok: true, code: "654321", verifyType: "magiclink" });
  });

  it("falls back to a sign-in code when the signup email already exists", async () => {
    const types: string[] = [];
    const issued = await createEmailOtp("sign-up", "person@example.com", async (params) => {
      types.push(params.type);
      if (params.type === "signup") {
        return { data: null, error: { message: "A user with this email address has already been registered" } } as unknown as GenerateLinkResponse;
      }
      return link("111222", "magiclink");
    });
    expect(types).toEqual(["signup", "magiclink"]);
    expect(issued).toEqual({ ok: true, code: "111222", verifyType: "magiclink" });
  });

  it("hides provider details in public errors", () => {
    expect(publicOtpError("sign-in", "User not found")).toBe("No Alfred account uses that email.");
    expect(publicOtpError("sign-up", "already been registered")).toBe("That email already has an account. Sign in instead.");
    expect(publicOtpError("sign-in", "database timeout")).toBe("Alfred could not send that code.");
  });
});

function link(code: string, verificationType: "magiclink" | "signup"): GenerateLinkResponse {
  return {
    data: {
      properties: {
        action_link: "https://example.test/verify",
        email_otp: code,
        hashed_token: "hashed",
        redirect_to: "",
        verification_type: verificationType,
      },
      user: { id: "user-1" },
    },
    error: null,
  } as GenerateLinkResponse;
}
