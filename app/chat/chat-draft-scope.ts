/** Only an explicit question/payment handoff owns a loading draft. */
export function chatDraftScope(question: unknown, payment: unknown): string {
  const values = (value: unknown) => typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return JSON.stringify([values(question), values(payment)]);
}
