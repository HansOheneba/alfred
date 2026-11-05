import type { StudioSettings, UserProfile } from "@/lib/config";
import { createSupabaseBankStore } from "@/lib/bank/store";
import { labelQuestion } from "@/lib/bank/ingest";
import { loadAccountingReadModel } from "@/lib/finance/accounting/persisted-store";
import { projectAccountingTransactions } from "@/lib/finance/accounting/view";
import { budgetMath } from "@/lib/finance/budgets";
import { zonedYmd } from "@/lib/finance/dates";
import { createSupabaseFinanceStore } from "@/lib/supabase/finance-store";
import { buildChatContext, type ChatContext } from "./chat-context";
import { loadLedgerSnapshot, type Ledger, type LedgerBank } from "./ledger";
import { loadLedgerBankMetadata } from "./ledger-bank-metadata";
import { durableDisplayEnabled } from "@/lib/finance/accounting/durable-read";
import { readDurableInsightFacts } from "./durable-insight-query";
import { durableBudgetMath,durablePlanningLedger,loadDurablePlanning } from "./durable-planning";
import { readDurableAccountFacts,readDurableBudgetSpending } from "./durable-secondary";
import { getGettingStartedState } from "@/app/components/getting-started-state";
import { addDays } from "@/lib/finance/dates";

export type SettingsBudgets = Pick<Ledger, "today" | "currency" | "budgets">;
export type SettingsGoals = Pick<Ledger, "currency" | "goals">;
export type SettingsBank = { currency: string; bank: LedgerBank };

export async function loadChatContext(profile: UserProfile, settings: StudioSettings) {
  if(durableDisplayEnabled()){
    const today=zonedYmd(new Date(),profile.timezone),resources=await loadDurablePlanning(profile,settings);
    const bundle=await readDurableInsightFacts(settings.supabase,profile,today,resources.bills,resources.held.map(row=>`bank:${row.id}`));
    if(bundle){
      const ledger=durablePlanningLedger(profile,today,bundle.manifest,resources,bundle.data),balances=ledger.accounting!.balances,facts=bundle.data.insights;
      const amounts=new Map(bundle.data.days.map(row=>[row.date,row.minor]));let cumulative=0;
      const days:ChatContext['month']['days']=[];
      for(let date=facts.range.start;date<=today;date=addDays(date,1)){const spent=amounts.get(date)??0;cumulative+=spent;days.push({date,label:`${Number(date.slice(8,10))} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(date.slice(5,7))-1]}`,spent,cumulative});}
      return {today,currency:profile.currency,setup:getGettingStartedState(ledger,{hasTransaction:bundle.manifest.ledger.count>0}),month:{...facts.range,spentMinor:facts.spentMinor,incomeMinor:facts.incomeMinor,categories:[...facts.categories].sort((left,right)=>right.minor-left.minor||left.category.localeCompare(right.category)).slice(0,4).map(({category,minor,count})=>({category,minor,count})),days},budgets:ledger.budgets.filter(row=>row.period===today.slice(0,7)),highlight:ledger.insights.find(line=>line.startsWith('Repeated spend'))??ledger.insights.find(line=>/ budget (is over|has)/.test(line))??ledger.insights.find(line=>line.includes('moved the most'))??null,
        balances:{availability:ledger.accounting!.availability,count:balances.count,totalMinor:balances.totalMinor,missingCount:balances.missingCount,accounts:balances.accounts.filter(row=>row.account.includeInCash&&row.account.currency===profile.currency).map(({account,snapshot})=>({id:account.id,label:account.label,balanceMinor:snapshot?.balanceMinor??null,occurredAt:snapshot?.occurredAt??null}))},bank:{balances:ledger.bank.balances,needsLabel:ledger.bank.needsLabel.slice(0,3),needsLabelCount:ledger.bank.needsLabel.length}} satisfies ChatContext;
    }
  }
  const { ledger } = await loadLedgerSnapshot(profile, settings, { receipts: false });
  return buildChatContext(ledger);
}

/** All saved months retain authoritative projected spending; transaction history stays server-side. */
export async function loadSettingsBudgets(profile: UserProfile, settings: StudioSettings): Promise<SettingsBudgets> {
  const ownerId = profile.profileId;
  const projected=await readDurableBudgetSpending(settings.supabase,ownerId);
  if(projected){const budgets=await createSupabaseFinanceStore(settings.supabase).listBudgets(ownerId);return {today:zonedYmd(new Date(),profile.timezone),currency:profile.currency,budgets:durableBudgetMath(budgets,projected.data)};}
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
  if(durableDisplayEnabled()){
    const [held,metadata]=await Promise.all([createSupabaseBankStore(settings.supabase).listMessages(ownerId,'needs_label'),loadLedgerBankMetadata(settings.supabase,ownerId)]);
    const selected=held.slice(0,20),projected=await readDurableAccountFacts(settings.supabase,ownerId,selected.map(row=>`bank:${row.id}`));
    if(projected){const review=new Set(projected.data.reviewIds);return {currency:profile.currency,bank:{...metadata,needsLabel:selected.filter(row=>review.has(`bank:${row.id}`)).map(row=>({id:row.id,direction:row.direction,amount:row.amount,currency:row.currency,counterparty:row.counterparty,occurredAt:row.occurredAt,question:labelQuestion(row,profile.timezone,profile.preferredName)}))}};}
  }
  const [held, metadata, accounting] = await Promise.all([createSupabaseBankStore(settings.supabase).listMessages(ownerId, "needs_label"), loadLedgerBankMetadata(settings.supabase, ownerId), loadAccountingReadModel(settings.supabase, ownerId)]);
  const review = new Set(accounting.state.movements.filter(item => item.status === "review").map(item => item.id));
  const needsLabel = held.slice(0, 20).filter(item => review.has(`bank:${item.id}`)).map(item => ({ id: item.id, direction: item.direction, amount: item.amount, currency: item.currency, counterparty: item.counterparty, occurredAt: item.occurredAt, question: labelQuestion(item, profile.timezone, profile.preferredName) }));
  return { currency: profile.currency, bank: { ...metadata, needsLabel } };
}
