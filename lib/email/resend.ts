import { buildOtpMessage } from "@/lib/email/otp-template";

const BARE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAMED_EMAIL = /^[^<>\r\n]{1,80}\s<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>$/;

export type ResendConfig = {
  apiKey: string;
  from: string;
};

export function formatFromAddress(value: string): string | null {
  const trimmed = value.trim();
  if (BARE_EMAIL.test(trimmed)) return `Alfred <${trimmed}>`;
  if (NAMED_EMAIL.test(trimmed)) return trimmed;
  return null;
}

export function readResendConfig(): ResendConfig | null {
  const apiKey = process.env.RESEND_API_KEY?.trim() ?? "";
  const from = formatFromAddress(process.env.RESEND_FROM_EMAIL ?? "");
  if (!apiKey || !from) return null;
  return { apiKey, from };
}

export type EmailContent = {
  subject: string;
  text: string;
  html: string;
};

export function otpEmail(code: string): Promise<EmailContent> {
  return buildOtpMessage(code);
}

export async function sendResendEmail(
  config: ResendConfig,
  input: EmailContent & { to: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; message: string }> {
  let response: Response;
  try {
    response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: config.from,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        html: input.html,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, message: "Resend could not be reached." };
  }
  if (response.ok) return { ok: true };
  let message = `Resend returned ${response.status}.`;
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === "string" && body.message.trim()) message = body.message.trim();
  } catch {
    // The status is enough when the body is not JSON.
  }
  return { ok: false, message };
}
