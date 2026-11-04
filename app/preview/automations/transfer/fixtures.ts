// Server-only fictional inputs: use the real copy and answer builders without
// opening a connection, importing history, or creating any real record.
import { chatChoices } from "@/lib/accounts/chat-choices";
import type { ChatChoice } from "@/lib/accounts/chat-choices";
import { paymentActivityMention } from "@/lib/bank/notices";
import { currentQuestion } from "@/lib/bank/reply";
import { MemoryBankStore, type BankMessage } from "@/lib/bank/store";
import type { UserProfile } from "@/lib/config";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { MemoryLoanStore } from "@/lib/finance/loans";

export type PaymentQuestionSample = { state: "incoming" | "outgoing"; body: string; intent: string; requiresPurpose: boolean; choices: ChatChoice[][] };

export async function paymentQuestionPreviewSamples(): Promise<PaymentQuestionSample[]> {
  return Promise.all((["in", "out"] as const).map(async direction => {
    const ownerId = "fictional-transfer-preview", id = "11111111-1111-4111-8111-111111111111";
    const message: BankMessage = {
      id, ownerId, source: direction === "in" ? "momo" : "hubtel", channel: "mac", externalId: null,
      direction, kind: "payment", amount: "1.00", fee: "0.00", currency: "GHS", counterparty: "Fictional Payer",
      balance: null, occurredAt: "2026-11-04T11:09:00.000Z", status: "needs_label", transactionId: null,
      feeTransactionId: null, askedAt: null, raw: "", readBy: "rules",
    };
    const bank = new MemoryBankStore();
    bank.messages.push({ ...message, textHash: `fictional-${direction}` });
    const profile: UserProfile = { profileId: ownerId, telegramUserId: null, spreadsheetId: "", currency: "GHS", timezone: "Africa/Accra", preferredName: "Sample", communicationPreference: "concise" };
    const question = await currentQuestion({ bank, ledger: new MemoryFinanceStore(), loans: new MemoryLoanStore(), now: new Date(message.occurredAt), createId: () => id }, profile, { currentMessageId: id });
    const mention = paymentActivityMention({ ...message, createdAt: message.occurredAt });
    if (!question || !mention) throw Error("The fictional payment question could not be prepared.");
    return { state: direction === "in" ? "incoming" : "outgoing", body: mention.body, intent: mention.intent, requiresPurpose: mention.requiresPurpose, choices: chatChoices(question.buttons) };
  }));
}
