const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]+/g,
  /\d{6,}:[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function sanitize(value: string): string {
  let output = value;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, "[redacted]");
  }
  return output.slice(0, 300);
}

export function logInfo(
  event: string,
  fields: Record<string, string | number | boolean> = {},
): void {
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    safe[key] = typeof value === "string" ? sanitize(value) : value;
  }
  console.info(JSON.stringify({ level: "info", event, ...safe }));
}

export function logError(event: string, error: unknown): void {
  const name = error instanceof Error ? error.name : "Error";
  const message = sanitize(error instanceof Error ? error.message : "Unknown error");
  console.error(JSON.stringify({ level: "error", event, name, message }));
}
