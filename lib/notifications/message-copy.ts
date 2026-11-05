export type MessagePush = { id: string; text?: string };

/** Called only after loading an owned assistant message and its latest preview consent. */
export function messagePushDetails(value: unknown): MessagePush | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id)) return null;
  if (input.text === undefined) return { id: input.id.toLowerCase() };
  if (typeof input.text !== "string") return null;
  const text = input.text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
  return { id: input.id.toLowerCase(), ...(text ? { text } : {}) };
}
