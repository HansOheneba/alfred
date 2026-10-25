import { MAX_IMAGE_BYTES } from "@/lib/ocr/read-image";

export type TelegramPhoto = { file_id: string; file_size?: number; width?: number };

/** The sharpest version of a photo that is still small enough to read. */
export function pickPhoto(sizes: TelegramPhoto[] | undefined): TelegramPhoto | null {
  if (!sizes?.length) return null;
  const fitting = sizes.filter((item) => !item.file_size || item.file_size <= MAX_IMAGE_BYTES);
  return (fitting.length ? fitting : sizes).reduce((best, item) => ((item.width ?? 0) > (best.width ?? 0) ? item : best));
}

/** Downloads a file a user sent the bot. The token stays on the server. */
export async function downloadTelegramFile(token: string, fileId: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const meta = await fetchImpl(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`, {
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await meta.json()) as { ok?: boolean; result?: { file_path?: string; file_size?: number } };
  const path = json.result?.file_path;
  if (!meta.ok || !json.ok || !path) throw new Error("Telegram getFile failed.");
  if ((json.result?.file_size ?? 0) > MAX_IMAGE_BYTES) throw new Error("Telegram file is too large.");
  const file = await fetchImpl(`https://api.telegram.org/file/bot${token}/${path}`, { signal: AbortSignal.timeout(20_000) });
  if (!file.ok) throw new Error(`Telegram file download failed with status ${file.status}.`);
  return Buffer.from(await file.arrayBuffer());
}
