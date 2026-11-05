import type { StudioSettings, UserProfile } from "@/lib/config";
import { createSupabaseBankStore } from "@/lib/bank/store";
import { labelQuestion } from "@/lib/bank/ingest";
import { loadAccountingReadModel } from "@/lib/finance/accounting/persisted-store";
import { projectAccountingTransactions } from "@/lib/finance/accounting/view";
import { budgetMath } from "@/lib/finance/budgets";
import { zonedYmd } from "@/lib/finance/dates";
import { createSupabaseFinanceStore } from "@/lib/supabase/finance-store";
import { buildChatContext } from "./chat-context";
import { loadLedgerSnapshot, type Ledger, type LedgerBank } from "./ledger";
import { loadLedgerBankMetadata } from "./ledger-bank-metadata";

export type SettingsBudgets = Pick<Ledger, "today" | "currency" | "budgets">;
export type SettingsGoals = Pick<Ledger, "currency" | "goals">;
export type SettingsBank = { currency: string; bank: LedgerBank };

export async function loadChatContext(profile: UserProfile, settings: StudioSettings) {
  const { ledger } = await loadLedgerSnapshot(profile, settings, { receipts: false });
  return buildChatContext(ledger);
}

/** All saved months retain authoritative projected spending; transaction history stays server-side. */
export async function loadSettingsBudgets(profile: UserProfile, settings: StudioSettings): Promise<SettingsBudgets> {
  const ownerId = profile.profileId;
  const [accounting, budgets] = await Promise.all([loadAccountingReadModel(settings.supabase, ownerId), createSupabaseFinanceStore(settings.supabase).listBudgets(ownerId)]);
  const transactions = accounting.availability === "ready" ? projectAccountingTransactions(accounting.rawTransactions, accounting.state) : accounting.rawTransactions;
  return { today: zonedYmd(new Date(), profile.timezone), currency: profile.currency, budgets: budgets.map(item => ({ budgetId: item.budgetId, period: item.period, category: item.category, amount: item.amount, currency: item.currency, ...budgetMath(item, transactions) })).sort((a, b) => b.period.localeCompare(a.period) || a.category.localeCompare(b.category)) };
}

/** Goals do not require transactions, balances, loans, bills or accounting hydration. */
export async function loadSettingsGoals(profile: UserProfile, settings: StudioSettings): Promise<SettingsGoals> {
  const goals = await createSupabaseFinanceStore(settings.supabase).listSavingsGoals(profile.profileId);
  return { currency: profile.currency, goals: goals.filter(item => item.status !== "deleted").map(item => ({ goalId: item.goalId, name: item.name, targetAmount: item.targetAmount, currentAmount: item.currentAmount, currency: item.currency, targetDate: item.targetDate, status: item.status === "completed" ? "completed" : "active" })) };
}

/** Preserve the existing waiting-item selection and canonical review filter without unrelated finance reads. */
export async function loadSettingsBank(profile: UserProfile, settings: StudioSettings): Promise<SettingsBank> {
  const ownerId = profile.profileId;
  const [held, metadata, accounting] = await Promise.all([createSupabaseBankStore(settings.supabase).listMessages(ownerId, "needs_label"), loadLedgerBankMetadata(settings.supabase, ownerId), loadAccountingReadModel(settings.supabase, ownerId)]);
  const review = new Set(accounting.state.movements.filter(item => item.status === "review").map(item => item.id));
  const needsLabel = held.slice(0, 20).filter(item => review.has(`bank:${item.id}`)).map(item => ({ id: item.id, direction: item.direction, amount: item.amount, currency: item.currency, counterparty: item.counterparty, occurredAt: item.occurredAt, question: labelQuestion(item, profile.timezone, profile.preferredName) }));
  return { currency: profile.currency, bank: { ...metadata, needsLabel } };
}
