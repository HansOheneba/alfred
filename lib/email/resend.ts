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

export function otpEmail(code: string): { subject: string; text: string; html: string } {
  const safeCode = code.replace(/[^\d]/g, "");
  return {
    subject: "Your Alfred code",
    text: `Your Alfred code is ${safeCode}. It expires shortly. If you did not ask for it, you can ignore this email.`,
    html: `<p>Your Alfred code is <strong style="font-size:20px;letter-spacing:0.2em">${escapeHtml(safeCode)}</strong>.</p><p>It expires shortly. If you did not ask for it, you can ignore this email.</p>`,
  };
}

export async function sendResendEmail(
  config: ResendConfig,
  input: { to: string; subject: string; text: string; html: string },
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });
}
