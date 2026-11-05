import type { LedgerRow } from "../analytics";
import type { TransactionRecord } from "../types";
import { accountBalances } from "./accounts";
import { settlementEffects, validateSettlements } from "./settlements";
import type { AccountingState, CashMovement } from "./types";

const money = (minor:number) => (minor / 100).toFixed(2);

/** Principal and fees are deliberately separate. Settlement offsets never consume fees. */
export function accountingReportRows(state: AccountingState): LedgerRow[] {
  return reportRowsWithEffects(state,settlementEffects(state));
}

function reportRowsWithEffects(state: AccountingState,effects:ReturnType<typeof settlementEffects>):LedgerRow[] {
  const accountNames = new Map(state.accounts.map((account) => [account.id,account.label]));
  const sourceCounts=new Map<string,number>();
  for(const movement of state.movements) if(movement.status!=="duplicate") {const key=JSON.stringify([movement.sourceKind,movement.sourceId]);sourceCounts.set(key,(sourceCounts.get(key)??0)+1);}
  const currentTransfers=new Set<string>();
  const linkedTransfers=new Set<string>();
  const movementsById=new Map<string,CashMovement>();
  for(const movement of state.movements) if(!movementsById.has(movement.id)) movementsById.set(movement.id,movement);
  for(const link of state.transfers) {
    linkedTransfers.add(link.outgoing.movementId);linkedTransfers.add(link.incoming.movementId);
    const out=movementsById.get(link.outgoing.movementId);
    const incoming=movementsById.get(link.incoming.movementId);
    if(out && incoming && out.ownerId===state.ownerId && incoming.ownerId===state.ownerId && out.sourceFingerprint===link.outgoing.sourceFingerprint && incoming.sourceFingerprint===link.incoming.sourceFingerprint && out.direction==="out" && incoming.direction==="in" && out.currency===incoming.currency && out.amountMinor===incoming.amountMinor && out.accountId && incoming.accountId && out.accountId!==incoming.accountId) {currentTransfers.add(out.id);currentTransfers.add(incoming.id);}
  }
  const rows: LedgerRow[] = [];
  const add = (movement:CashMovement,id:string,type:LedgerRow["type"],minor:number,category:string,description:string) => {
    if (!minor) return;
    rows.push({id,date:movement.date,type,minor,amount:money(minor),currency:movement.currency,category,description,paymentMethod:accountNames.get(movement.accountId ?? "") ?? movement.sourceLabel ?? "Manual / cash"});
  };
  for (const movement of state.movements) {
    if (movement.ownerId !== state.ownerId) continue;
    if((sourceCounts.get(JSON.stringify([movement.sourceKind,movement.sourceId]))??0)>1) continue;
    // Changed source evidence invalidates both transfer legs; no partial old exclusion survives.
    const status=movement.status==="transfer" && movement.sourceStatus!=="transfer" && linkedTransfers.has(movement.id) && !currentTransfers.has(movement.id) ? movement.sourceStatus ?? "review" : movement.status;
    if (status !== "confirmed" && status !== "transfer" && status !== "hold") {
      if (movement.sourceKind === "bank" && movement.feeTransactionId && !movement.sourceMissing && Number.isSafeInteger(movement.confirmedFeeMinor) && (movement.confirmedFeeMinor ?? 0) > 0 && movement.confirmedFeeMinor! <= movement.feeMinor) add(movement,`accounting-fee:${movement.id}`,"expense",movement.confirmedFeeMinor!,"Fees",`${movement.description} · fee`);
      continue;
    }
    const effect = effects.get(movement.id);
    if (status !== "transfer" && movement.direction !== "internal" && movement.legacyClassification !== "loan") {
      if (movement.legacyClassification === "refund") add(movement,`accounting:${movement.id}`,"expense",-movement.amountMinor,movement.category,movement.description);
      else if (movement.direction === "out") add(movement,`accounting:${movement.id}`,"expense",movement.amountMinor-(effect?.spendingOffsetMinor ?? 0),movement.category,movement.description);
      else if (status === "confirmed") add(movement,`accounting:${movement.id}`,"income",movement.amountMinor-(effect?.receivedOffsetMinor ?? 0),movement.category,movement.description);
    }
    add(movement,`accounting-fee:${movement.id}`,"expense",movement.feeMinor,"Fees",`${movement.description} · fee`);
    add(movement,`accounting-tax:${movement.id}`,"expense",movement.taxMinor ?? 0,"Taxes",`${movement.description} · tax`);
  }
  return rows.sort((a,b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

export function buildAccountingView(state: AccountingState, currency:string) {
  const resolved = validateSettlements(state);
  const reportRows = accountingReportRows(state);
  return {
    balances:accountBalances(state,currency),settlementIssues:resolved.issues,reportRows,
    loans:resolved.valid.filter((item) => item.link.kind === "loan").map((item) => ({settlementId:item.link.id,originalMovementId:item.original.id,description:item.original.description,currency:item.original.currency,principalMinor:item.original.amountMinor,returnedMinor:item.returnedMinor,outstandingMinor:item.outstandingMinor})),
    totals:{incomeMinor:reportRows.filter((row) => row.currency === currency && row.type === "income").reduce((sum,row) => sum+row.minor,0),spentMinor:reportRows.filter((row) => row.currency === currency && row.type === "expense").reduce((sum,row) => sum+row.minor,0)},
  };
}

/** Overlay only explicit accounting changes. Unclassified legacy refunds/loans retain their old semantics. */
export function projectAccountingTransactions(raw:TransactionRecord[],state:AccountingState):TransactionRecord[] {
  const effects = settlementEffects(state);
  const linkedTransfers=new Set(state.transfers.flatMap((link) => [link.incoming.movementId,link.outgoing.movementId]));
  const managed = state.movements.filter((movement) => movement.ownerId === state.ownerId && (movement.importProvenance !== undefined || movement.legacyClassification === null) && (
    movement.importProvenance !== undefined ||
    effects.has(movement.id) || linkedTransfers.has(movement.id)
    || (movement.sourceStatus !== undefined && movement.status !== movement.sourceStatus)
  ));
  const managedIds = new Set(managed.map((movement) => movement.id));
  const managedById = new Map(managed.map((movement) => [movement.id,movement]));
  // Missing bank evidence cannot claim an active transaction that now appears as its own fresh source.
  const replacedIds = new Set(managed.flatMap((movement) => movement.sourceMissing ? [] : [movement.legacyTransactionId,movement.feeTransactionId]).filter((id):id is string => id !== null));
  const derived = reportRowsWithEffects(state,effects).filter((row) => managedIds.has(row.id.replace(/^accounting(?:-fee|-tax)?:/,""))).map((row):TransactionRecord => ({
    transactionId:row.id,createdAt:managedById.get(row.id.replace(/^accounting(?:-fee|-tax)?:/,""))?.occurredAt ?? `${row.date}T00:00:00.000Z`,transactionDate:row.date,userId:state.ownerId,type:row.type,amount:row.amount,currency:row.currency,category:row.category,description:row.description,paymentMethod:row.paymentMethod,notes:"Accounting projection; edit source/link in Accounts.",status:"active",updatedAt:new Date(0).toISOString(),sourceUpdateId:row.id,rowNumber:0,
  }));
  const metadata=new Map(state.movements.filter((movement) => movement.ownerId===state.ownerId && movement.legacyTransactionId!==null && movement.status!=="duplicate").map((movement) => [movement.legacyTransactionId,movement]));
  const accountNames=new Map(state.accounts.map((account) => [account.id,account.label]));
  return [...raw.filter((row) => !replacedIds.has(row.transactionId)).map((row) => {
    const movement=metadata.get(row.transactionId);if(!movement) return row;
    return {...row,...(movement.sourceCategory!==undefined && movement.category!==movement.sourceCategory ? {category:movement.category} : {}),...(movement.accountId && accountNames.has(movement.accountId) ? {paymentMethod:accountNames.get(movement.accountId)!} : {})};
  }),...derived];
}
