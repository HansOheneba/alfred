import { createSign } from "node:crypto";

import { z } from "zod";

import type { GoogleSettings } from "@/lib/config";
import { LIMITS } from "@/lib/config";
import { SheetsError } from "@/lib/errors";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional(),
});

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function resetAccessTokenCache(): void {
  tokenCache.clear();
}

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

export function signServiceAccountJwt(
  email: string,
  privateKey: string,
  nowSeconds: number,
): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const unsigned = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

export async function getGoogleAccessToken(
  settings: GoogleSettings,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<string> {
  const cached = tokenCache.get(settings.clientEmail);
  if (cached && cached.expiresAt > now + 60_000) return cached.token;

  const assertion = signServiceAccountJwt(
    settings.clientEmail,
    settings.privateKey,
    Math.floor(now / 1000),
  );
  let response: Response;
  try {
    response = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(LIMITS.googleTimeoutMs),
    });
  } catch {
    throw new SheetsError("unavailable", "Google authentication timed out.");
  }

  if (!response.ok) {
    throw new SheetsError(
      response.status === 401 || response.status === 403 ? "credentials" : "unavailable",
      "Google rejected the service account credentials.",
    );
  }

  const parsed = tokenSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new SheetsError("credentials", "Google authentication returned an unexpected response.");
  }
  const expiresIn = parsed.data.expires_in ?? 3600;
  tokenCache.set(settings.clientEmail, {
    token: parsed.data.access_token,
    expiresAt: now + expiresIn * 1000,
  });
  return parsed.data.access_token;
}
