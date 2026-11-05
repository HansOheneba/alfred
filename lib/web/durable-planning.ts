import type { StudioSettings, UserProfile } from "@/lib/config";
import { createSupabaseFinanceStore } from "@/lib/supabase/finance-store";
import { createSupabaseBankStore } from "@/lib/bank/store";
import { labelQuestion } from "@/lib/bank/ingest";
import { createSupabaseLoanStore, loanBalances, type LoanBalance } from "@/lib/finance/loans";
import { createSupabaseBillStore, upcomingBills } from "@/lib/finance/bills";
import { formatDisplayInsights, formatDisplayRenewals } from "@/lib/finance/display-insight-facts";
import { balanceForCurrency } from "@/lib/finance/accounting/accounts-model";
import type { AccountingDisplayManifest } from "@/lib/finance/accounting/display-model";
import { toMinor } from "@/lib/finance/money";
import { loadLedgerBankMetadata } from "./ledger-bank-metadata";
import type { Ledger, LedgerBudget } from "./ledger";
import type { DurableInsightData } from "./durable-insight-query";

/** Native resources keep their existing ownership and freshness boundaries. No accounting source history. */
export async function loadDurablePlanning(profile: UserProfile, settings: StudioSettings) {
 const owner=profile.profileId,store=createSupabaseFinanceStore(settings.supabase);
 const [budgets,goals,loans,bills,held,metadata]=await Promise.all([store.listBudgets(owner),store.listSavingsGoals(owner),createSupabaseLoanStore(settings.supabase).list(owner),createSupabaseBillStore(settings.supabase).list(owner),createSupabaseBankStore(settings.supabase).listMessages(owner,'needs_label'),loadLedgerBankMetadata(settings.supabase,owner)]);
 return {budgets,goals,loans,bills,held:held.slice(0,20),metadata};
}
export function durableBudgetMath(budgets: Awaited<ReturnType<typeof loadDurablePlanning>>['budgets'], spending: DurableInsightData['budgetSpending']): LedgerBudget[] {
 return budgets.map(budget=>{const spentMinor=spending.find(row=>row.period===budget.period&&row.currency===budget.currency&&row.category===budget.category)?.spentMinor??0,budgetMinor=toMinor(budget.amount);return {budgetId:budget.budgetId,period:budget.period,category:budget.category,amount:budget.amount,currency:budget.currency,spentMinor,budgetMinor,remainingMinor:budgetMinor-spentMinor};}).sort((a,b)=>b.period.localeCompare(a.period)||a.category.localeCompare(b.category));
}
export function durablePlanningLedger(profile: UserProfile,today:string,manifest:AccountingDisplayManifest,resources:Awaited<ReturnType<typeof loadDurablePlanning>>,facts:DurableInsightData):Ledger {
 const review=new Set(facts.reviewIds),balances=loanBalances(resources.loans),accounting=manifest.accounts;
 const linked:LoanBalance[]=accounting.linkedLoans.filter(row=>row.outstandingMinor>0).map(row=>({person:row.description,personKey:`accounting:${row.settlementId}`,currency:row.currency,lent:(row.principalMinor/100).toFixed(2),repaid:(row.returnedMinor/100).toFixed(2),owed:(row.outstandingMinor/100).toFixed(2),borrowed:'0.00',paidBack:'0.00',owe:'0.00',since:accounting.linkedLoanDates[row.originalMovementId]??''}));
 return {today,currency:profile.currency,rows:[],budgets:durableBudgetMath(resources.budgets,facts.budgetSpending),
  goals:resources.goals.filter(row=>row.status!=='deleted').map(row=>({goalId:row.goalId,name:row.name,targetAmount:row.targetAmount,currentAmount:row.currentAmount,currency:row.currency,targetDate:row.targetDate,status:row.status==='completed'?'completed':'active'})),
  insights:formatDisplayInsights(facts.insights,resources.budgets),bank:{...resources.metadata,needsLabel:resources.held.filter(row=>review.has(`bank:${row.id}`)).map(row=>({id:row.id,direction:row.direction,amount:row.amount,currency:row.currency,counterparty:row.counterparty,occurredAt:row.occurredAt,question:labelQuestion(row,profile.timezone,profile.preferredName)}))},
  owed:[...balances.filter(row=>Number(row.owed)>0),...linked].sort((a,b)=>Number(b.owed)-Number(a.owed)),owe:balances.filter(row=>Number(row.owe)>0).sort((a,b)=>Number(b.owe)-Number(a.owe)),
  bills:resources.bills,upcomingBills:upcomingBills(resources.bills,today),renewalSuggestions:formatDisplayRenewals(facts.renewals,today,profile.currency),
  accounting:{availability:accounting.availability,revision:accounting.revision,balances:balanceForCurrency(accounting.accountFacts,profile.currency),loans:accounting.linkedLoans,issues:accounting.settlementIssues}};
}
