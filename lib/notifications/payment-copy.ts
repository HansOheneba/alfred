/** Deliberately small, structured lock-screen data. Never include raw SMS or payee text. */
export type PaymentPushDetails = {
  amount: string;
  currency: string;
  direction: "in" | "out";
  /** A bank alert is not independent evidence of settled spending. */
  activity?: "card_hold" | "hold_settle";
  transfer?: { fromAccount?: string; toAccount?: string };
};
export type PaymentPushContext = { targetId: string; details: PaymentPushDetails };

function accountLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  return label.length > 0 && label.length <= 60 && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(label) ? label : null;
}

/** Validate again at the payload boundary, even when the database supplied it. */
export function paymentPushDetails(value: unknown): PaymentPushDetails | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.amount !== "string" || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(input.amount) ||
      !/[1-9]/.test(input.amount) || typeof input.currency !== "string" || !/^[A-Z]{3}$/.test(input.currency) ||
      (input.direction !== "in" && input.direction !== "out")) return null;
  const [whole, fraction = ""] = input.amount.split(".");
  const result: PaymentPushDetails = { amount: `${whole}.${fraction.padEnd(2, "0")}`, currency: input.currency, direction: input.direction };
  if (input.activity !== undefined) {
    if (!["card_hold", "hold_settle"].includes(input.activity as string) || input.direction !== "out" || input.transfer !== undefined) return null;
    result.activity = input.activity as PaymentPushDetails["activity"];
  }
  if (input.transfer !== undefined) {
    if (!input.transfer || typeof input.transfer !== "object" || Array.isArray(input.transfer)) return null;
    const transfer = input.transfer as Record<string, unknown>;
    const fromAccount = accountLabel(transfer.fromAccount), toAccount = accountLabel(transfer.toAccount);
    // Labels are optional; a malformed label cannot turn into arbitrary push text.
    result.transfer = fromAccount && toAccount ? { fromAccount, toAccount } : {};
  }
  return result;
}

/** Keep this deterministic formatter in sync with the push-only worker. */
export function paymentPushBody(details: PaymentPushDetails): string {
  const valid = paymentPushDetails(details);
  if (!valid) throw new Error("Invalid payment notification details.");
  const [whole, fraction] = valid.amount.split(".");
  const amount = `${valid.currency === "GHS" ? "GH₵" : `${valid.currency} `}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
  if (valid.activity === "card_hold") return `Card hold · ${amount}. Open Alfred to chat.`;
  if (valid.activity === "hold_settle") return `Card settlement alert · ${amount}. Open Alfred to review.`;
  if (valid.transfer) {
    const { fromAccount, toAccount } = valid.transfer;
    return fromAccount && toAccount ? `Transfer · ${amount} · ${fromAccount} → ${toAccount}.` : `Transfer · ${amount} between your accounts.`;
  }
  return `${valid.direction === "in" ? "Money in · +" : "Money out · −"}${amount}. Open Alfred to chat.`;
}
