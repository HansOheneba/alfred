import type { InterpretRequest } from "@/lib/ai/deepseek";
import type { MessageLog } from "@/lib/accounts/messages";
import type { UserProfile } from "@/lib/config";
import { LIMITS } from "@/lib/config";
import { applyFollowUp, readConversation, type ConversationContext } from "@/lib/finance/conversation";
import type { FinanceAction } from "@/lib/finance/schemas";
import type { FinanceStore } from "@/lib/finance/store";

export async function interpretWithContext(input: {
  text: string;
  profile: UserProfile;
  store: FinanceStore;
  now: Date;
  interpret: (request: InterpretRequest) => Promise<FinanceAction>;
  messages?: MessageLog | null;
  excludeClientId?: string | null;
}): Promise<{ action: FinanceAction; context: ConversationContext | null }> {
  const ownerId = input.profile.profileId;
  const recent = (await input.store.listTransactions(ownerId))
    .filter((item) => item.status === "active")
    .sort((left, right) => right.transactionDate.localeCompare(left.transactionDate) || right.rowNumber - left.rowNumber)
    .slice(0, LIMITS.recentContext)
    .map((item) => ({
      transactionId: item.transactionId,
      transactionDate: item.transactionDate,
      type: item.type,
      amount: item.amount,
      currency: item.currency,
      category: item.category,
      description: item.description.slice(0, 80),
    }));
  const context = await readConversation(input.store, ownerId);
  const [budgets, goals, history] = await Promise.all([
    input.store.listBudgets(ownerId),
    input.store.listSavingsGoals(ownerId),
    input.messages ? input.messages.listRecent(ownerId, LIMITS.maxHistory) : Promise.resolve([]),
  ]);
  const action = applyFollowUp(
    input.text,
    await input.interpret({
      text: input.text,
      timezone: input.profile.timezone,
      currency: input.profile.currency,
      now: input.now,
      recent,
      context,
      preferredName: input.profile.preferredName,
      communicationPreference: input.profile.communicationPreference,
      budgets: budgets.slice(0, 12).map((item) => ({
        period: item.period,
        category: item.category,
        amount: item.amount,
        currency: item.currency,
      })),
      goals: goals.slice(0, 8).map((item) => ({
        name: item.name,
        currentAmount: item.currentAmount,
        targetAmount: item.targetAmount,
        currency: item.currency,
      })),
      history: history
        .filter((item) => !input.excludeClientId || item.clientId !== input.excludeClientId)
        .map((item) => ({
          role: item.role,
          body: item.body.slice(0, 500),
        })),
    }),
    context,
  );
  return { action, context };
}
