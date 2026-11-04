import type { BankMessage } from "./store";

/** Captured payment notices stay open until explained or positively matched.
 * Historical exclusions and explicit manual accounting operations are separate. */
export function isUnresolvedPaymentNotice(message: Pick<BankMessage, "channel" | "status" | "direction">): boolean {
  return ["mac", "shortcut"].includes(message.channel) && message.status === "needs_label" && ["in", "out"].includes(message.direction);
}

export const PAYMENT_NOTICE_STAYS_PENDING = "I'll keep this payment pending until we know what it was for. Choose Ask something else if you want to talk about something different, then come back to it.";

/** A direct dismissal request is not a classification, even if a model could
 * interpret it as the legacy skip label. New-topic handling remains separate. */
export function isPaymentSkipRequest(text: string): boolean {
  return /^(?:(?:please|just)\s+)*(?:skip|ignore|dismiss)(?:\s+(?:it|this|that|this\s+(?:payment|notice|alert)|that\s+(?:payment|notice|alert)|the\s+(?:payment|notice|alert)|all(?:\s+of\s+them)?|them))?(?:\s+(?:for\s+now|please))?\s*[.!]*$/i.test(text.trim()) ||
    /^(?:(?:please|just)\s+)*leave\s+(?:it|this|that|this\s+payment|that\s+payment)\s+out(?:\s+for\s+now)?\s*[.!]*$/i.test(text.trim());
}
