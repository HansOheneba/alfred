import { z } from "zod";

import { chatCompletion } from "@/lib/ai/deepseek";
import type { DeepSeekSettings, GoogleSettings } from "@/lib/config";
import { getGoogleAccessToken, VISION_SCOPE } from "@/lib/google/auth";
import { logError } from "@/lib/log";

export type ImageText = {
  text: string;
  /** What the image looked like: bank or mobile money texts, a receipt, or something else. */
  kind: "bank_sms" | "receipt" | "other";
  engine: "deepseek" | "google-vision";
};

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"];

const transcriptSchema = z.object({
  text: z.string().max(12_000),
  kind: z.enum(["bank_sms", "receipt", "other"]).catch("other"),
});

const TRANSCRIBE = [
  "You transcribe screenshots for a personal finance assistant. Return JSON only: {\"text\":\"...\",\"kind\":\"bank_sms|receipt|other\"}.",
  "kind is bank_sms for bank or mobile money text messages, receipt for receipts or invoices, other for anything else.",
  "For bank_sms: copy every message word for word, in order, each on its own line. Put each date heading, such as Sun, 4 Oct at 8:15 AM, on its own line before the messages under it. Keep amounts, names, balances and transaction IDs exactly as shown. Skip the phone's interface, such as the message box and buttons.",
  "For receipt: copy the merchant, date, each item with its price, and the total.",
  "Never invent text you cannot read. If nothing is legible, return an empty text.",
].join("\n");

async function withDeepSeek(settings: DeepSeekSettings, bytes: Buffer, mime: string, fetchImpl: typeof fetch): Promise<ImageText> {
  const content = await chatCompletion(
    settings,
    [
      { role: "system", content: TRANSCRIBE },
      {
        role: "user",
        content: [
          { type: "text", text: "Transcribe this image." },
          { type: "image_url", image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` } },
        ],
      },
    ],
    { temperature: 0, maxTokens: 3000, timeoutMs: 40_000 },
    fetchImpl,
  );
  const parsed = transcriptSchema.parse(JSON.parse(content));
  return { text: parsed.text.trim(), kind: parsed.kind, engine: "deepseek" };
}

async function withGoogleVision(settings: GoogleSettings, bytes: Buffer, fetchImpl: typeof fetch): Promise<ImageText> {
  const token = await getGoogleAccessToken(settings, fetchImpl, Date.now(), VISION_SCOPE);
  const response = await fetchImpl("https://vision.googleapis.com/v1/images:annotate", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ requests: [{ image: { content: bytes.toString("base64") }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }] }] }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Google Vision failed with status ${response.status}.`);
  const json = (await response.json()) as { responses?: { fullTextAnnotation?: { text?: string } }[] };
  const text = json.responses?.[0]?.fullTextAnnotation?.text?.trim() ?? "";
  const kind = /GHS|CEDIS|Transaction ID|Current Balance/i.test(text) ? "bank_sms" : /total|subtotal|receipt|invoice/i.test(text) ? "receipt" : "other";
  return { text, kind, engine: "google-vision" };
}

/**
 * Reads the text in a screenshot or photo. DeepSeek reads images as part of
 * Alfred's normal model; Google Cloud Vision is the backup when it's set up
 * (GOOGLE_VISION_ENABLED=true and the Sheets service account has Vision access).
 */
export async function readImageText(
  input: { bytes: Buffer; mime: string; deepseek: DeepSeekSettings | null; google: GoogleSettings | null },
  fetchImpl: typeof fetch = fetch,
): Promise<ImageText> {
  const errors: unknown[] = [];
  if (input.deepseek) {
    try {
      const result = await withDeepSeek(input.deepseek, input.bytes, input.mime, fetchImpl);
      if (result.text) return result;
    } catch (error) {
      errors.push(error);
      logError("ocr_deepseek", error);
    }
  }
  if (input.google && process.env.GOOGLE_VISION_ENABLED === "true") {
    try {
      return await withGoogleVision(input.google, input.bytes, fetchImpl);
    } catch (error) {
      errors.push(error);
      logError("ocr_google", error);
    }
  }
  if (errors.length > 0) throw new Error("No image reader could read that image.");
  return { text: "", kind: "other", engine: "deepseek" };
}
