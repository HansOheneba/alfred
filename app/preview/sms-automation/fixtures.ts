// Server-side fictional examples. This file never opens a database or sends an update.
import { incomingPaymentMention, paymentActivityMention, type MentionCandidate } from "@/lib/bank/notices";
import { automationPreviewAllowed } from "@/lib/preview/access";

export function localAutomationPreviewAllowed(environment: Record<string, string | undefined>): boolean {
  return automationPreviewAllowed(environment);
}

export function paymentMentionPreviewCopies(): { knownCopy: string; unknownCopy: string; uncertainCopy: string; outgoingKnownCopy: string; outgoingUnknownCopy: string; outgoingUncertainCopy: string } {
  const fixture: MentionCandidate = {
    id: "11111111-1111-4111-8111-111111111111", ownerId: "preview-owner", channel: "mac",
    direction: "in", kind: "payment", amount: "250.00", currency: "GHS", counterparty: "Sample Sender",
    occurredAt: "2026-11-03T11:30:00.000Z", createdAt: "2026-11-03T11:30:00.000Z",
    status: "recorded", transactionId: "22222222-2222-4222-8222-222222222222", feeTransactionId: null, readBy: "rules",
    purpose: { ownerId: "preview-owner", transactionId: "22222222-2222-4222-8222-222222222222", category: "Business", description: "Freelance work", recordStatus: "active" },
  };
  const known = incomingPaymentMention(fixture);
  const unknown = incomingPaymentMention({ ...fixture, id: "33333333-3333-4333-8333-333333333333", amount: "80.00", status: "needs_label", transactionId: null, purpose: null });
  const uncertain = incomingPaymentMention({ ...fixture, id: "44444444-4444-4444-8444-444444444444", amount: "125.00", status: "needs_label", transactionId: null, readBy: "model", purpose: null });
  const outgoing: MentionCandidate = { ...fixture, direction: "out", amount: "45.00", fee: "0.50", counterparty: "Sample Shop", principalType: "expense", principalAmount: "45.00", purpose: { ...fixture.purpose!, category: "Food", description: "Lunch" } };
  const outgoingKnown = paymentActivityMention(outgoing);
  const outgoingUnknown = paymentActivityMention({ ...outgoing, id: "55555555-5555-4555-8555-555555555555", amount: "80.00", status: "needs_label", transactionId: null, principalType: null, principalAmount: null, purpose: null });
  const outgoingUncertain = paymentActivityMention({ ...outgoing, id: "66666666-6666-4666-8666-666666666666", amount: "125.00", status: "needs_label", transactionId: null, principalType: null, principalAmount: null, readBy: "model", purpose: null });
  if (!known || !unknown || !uncertain || !outgoingKnown || !outgoingUnknown || !outgoingUncertain) throw new Error("The fictional payment preview could not be prepared.");
  return { knownCopy: known.body, unknownCopy: unknown.body, uncertainCopy: uncertain.body, outgoingKnownCopy: outgoingKnown.body, outgoingUnknownCopy: outgoingUnknown.body, outgoingUncertainCopy: outgoingUncertain.body };
}
