import type { ChatMessageRecord } from "@/lib/accounts/messages";
import { paymentReplyContext, type ThreadMessage } from "@/lib/accounts/thread";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A locator only. Every source read still requires the authenticated owner. */
export function paymentLinkId(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}

/** Post-login destinations are deliberately limited to notification Chat links. */
export function paymentSignInReturn(value: unknown): string {
  if (typeof value !== "string") return "/";
  const match = /^\/chat\?payment=([0-9a-f-]+)$/i.exec(value);
  const id = paymentLinkId(match?.[1]);
  return id ? `/chat?payment=${id}` : "/";
}

/** A notification reply must not drift to a later, unrelated alert. Retries keep
 * their original binding, including an explicitly unrelated earlier message. */
export function linkedPaymentReplyContext(
  messages: ThreadMessage[], clientId: string | undefined,
  selected: ChatMessageRecord["paymentNotice"] | null | undefined,
): ChatMessageRecord["paymentNotice"] | null {
  const original = clientId && messages.find(message => message.role === "user" && message.clientId === clientId);
  if (original) return original.paymentNotice;
  return selected !== undefined ? selected : paymentReplyContext(messages, clientId);
}
