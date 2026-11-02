import {describe,expect,it,vi} from "vitest";
import {handleAction,type ActionContext} from "@/lib/finance/action-router";
import {MemoryFinanceStore} from "@/lib/finance/memory-store";
import type {FinanceStore} from "@/lib/finance/store";
import {accountBalances} from "@/lib/finance/accounting/accounts";
import {emptyAccountingState} from "@/lib/finance/accounting/types";
import {MemoryLoanStore} from "@/lib/finance/loans";

const NOW="2026-11-02T12:00:00Z";
function setup(missing=false) {
  const state=emptyAccountingState("owner");
  state.accounts=[{id:"bank-a",label:"Current account",provider:"Same bank",currency:"GHS",includeInCash:true,createdAt:NOW},{id:"bank-b",label:"Savings account",provider:"Same bank",currency:"GHS",includeInCash:true,createdAt:NOW},{id:"usd",label:"Dollar account",provider:"Same bank",currency:"USD",includeInCash:true,createdAt:NOW},{id:"excluded",label:"Excluded account",provider:"Same bank",currency:"GHS",includeInCash:false,createdAt:NOW}];
  state.snapshots=state.accounts.filter((account) => !missing || account.id!=="bank-b").map((account) => ({id:`snapshot:${account.id}`,accountId:account.id,balanceMinor:10000,occurredAt:NOW,sourceId:`manual:${account.id}`,sourceMovementId:null}));
  const store:FinanceStore=new MemoryFinanceStore();
  store.getAccountBalances=vi.fn(async () => accountBalances(state,"GHS"));
  const bank=vi.fn(async () => [{source:"gcb" as const,balance:"999.00",at:NOW}]);
  const ctx:ActionContext={store,profile:{profileId:"owner",telegramUserId:null,spreadsheetId:"synthetic",currency:"GHS",timezone:"Africa/Accra",preferredName:"Alex",communicationPreference:"concise"},now:new Date(NOW),updateId:1,chatId:1,confirmTransactions:"auto",pendingTtlMs:60000,createId:()=>"id",createActionId:()=>"action",bank:{ignoreAccount:null,balances:bank}};
  return {ctx,bank,store};
}
describe("chat uses explicit financial account snapshots",() => {
  it("keeps same-provider accounts distinct and excludes optouts and foreign currencies from the cash total",async () => {
    const {ctx,bank,store}=setup();
    const result=await handleAction({type:"get_financial_overview",period:"this_month"},ctx);
    expect(result.text).toContain("Current account");expect(result.text).toContain("Savings account");
    expect(result.text).toContain("Included cash balance: GH₵200.00 from 2 accounts");
    expect(result.text).toContain("Dollar account");expect(result.text).toContain("excluded from this currency's cash total");
    expect(bank).not.toHaveBeenCalled();expect(store.getAccountBalances).toHaveBeenCalledWith("owner","GHS");
  });
  it("keeps total unknown when any included account lacks a current snapshot",async () => {
    const {ctx}=setup(true);const result=await handleAction({type:"get_financial_overview",period:"this_month"},ctx);
    expect(result.text).toContain("Included cash balance is unknown: 1 of 2 included accounts");
    expect(result.text).not.toContain("Included cash balance: GH₵100.00");
  });
  it("labels legacy provider message evidence explicitly before the accounting migration",async () => {
    const {ctx,store,bank}=setup();store.getAccountBalances=async()=>null;
    const result=await handleAction({type:"get_financial_overview",period:"this_month"},ctx);
    expect(result.text).toContain("Latest provider message snapshots; real accounts are not reconciled or combined here");
    expect(result.text).not.toContain("Included cash balance:");expect(bank).toHaveBeenCalledOnce();
  });
  it("lists exact linked-loan descriptions and partial principal without merging legacy person balances",async () => {
    const {ctx,store}=setup();ctx.loans=new MemoryLoanStore();
    await ctx.loans.add("owner",{person:"Kofi",kind:"lent",amount:"50.00",currency:"GHS",occurredAt:NOW,note:"Synthetic legacy cash loan",bankMessageId:null});
    store.listLinkedLoans=vi.fn(async()=>[{settlementId:"linked-loan",originalMovementId:"payment",description:"Synthetic loan payment",currency:"GHS",principalMinor:60000,returnedMinor:15000,outstandingMinor:45000}]);
    const result=await handleAction({type:"get_loans",person:null},ctx);
    expect(result.text).toContain("Kofi: GH₵50.00");
    expect(result.text).toContain("Synthetic loan payment: GH₵450.00 outstanding; GH₵150.00 principal returned of GH₵600.00");
    expect(result.text.match(/Synthetic loan payment:/g)).toHaveLength(1);
    expect(store.listLinkedLoans).toHaveBeenCalledWith("owner");
    const person=await handleAction({type:"get_loans",person:"Synthetic"},ctx);
    expect(person.text).toContain("I haven't guessed which person each description means");
  });
  it("can list linked loans without a legacy LoanStore and directs repayment edits to Accounts",async()=>{
    const {ctx,store}=setup();store.listLinkedLoans=async()=>[{settlementId:"linked",originalMovementId:"payment",description:"Synthetic fully repaid loan",currency:"GHS",principalMinor:60000,returnedMinor:60000,outstandingMinor:0}];
    const result=await handleAction({type:"get_loans",person:null},ctx);
    expect(result.text).toContain("GH₵0.00 outstanding");expect(result.text).toContain("Review or link repayments in Accounts");
    expect(result.text).not.toContain("No one owes you anything");
  });
});
