import { createHash } from "node:crypto";
import type { BankMessage } from "../../bank/store";
import { toMinor } from "../money";
import type { TransactionRecord } from "../types";
import { stableJson } from "./reducer";
import type { AccountingState, CashMovement, MovementStatus } from "./types";

const hash = (data:unknown) => createHash("sha256").update(stableJson(data)).digest("hex");
const legacyLoan = new Set(["loan","lent","repaid","borrowed","paid_back"]);

function sourceDescription(direction:CashMovement["direction"],...values:(string|null|undefined)[]):string {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)
    ?? (direction === "in" ? "Incoming payment" : direction === "out" ? "Outgoing payment" : "Bank payment");
}


/** Build exact source identities. Provider names and payment labels never assign a financial account. */
export function sourceMovements(ownerId:string,transactions:TransactionRecord[],messages:BankMessage[]):CashMovement[] {
  const rows:CashMovement[] = [];
  const transactionsById = new Map(transactions.filter((row) => row.userId===ownerId).map((row) => [row.transactionId,row]));
  const claimedTransactions = new Set<string>();
  const priority=(message:BankMessage) => {
    const transaction=transactionsById.get(message.transactionId ?? "");
    if(transaction?.sourceUpdateId===`bank:${message.id}`) return 0;
    return message.status==="recorded" ? 1 : message.status==="matched" ? 3 : 2;
  };
  for (const message of [...messages].sort((a,b) => priority(a)-priority(b) || a.id.localeCompare(b.id))) {
    if (message.ownerId !== ownerId) continue;
    const transaction = transactionsById.get(message.transactionId ?? "");
    const feeTransaction = transactionsById.get(message.feeTransactionId ?? "");
    const duplicate = message.transactionId !== null && claimedTransactions.has(message.transactionId);
    if (message.transactionId) claimedTransactions.add(message.transactionId);
    if (message.feeTransactionId) claimedTransactions.add(message.feeTransactionId);
    let status:MovementStatus = message.status === "needs_label" ? "review" : message.status === "skipped" ? "excluded" : message.status === "transfer" || message.status === "invested" ? "transfer" : "confirmed";
    if (message.kind === "card_hold" && status === "confirmed") status = "hold";
    if (transaction?.status === "deleted") status = "excluded";
    if (duplicate) status = "duplicate";
    const category = transaction?.category ?? "Uncategorized";
    rows.push({
      id:`bank:${message.id}`,ownerId,accountId:null,direction:message.direction,status,sourceStatus:status,
      amountMinor:toMinor(message.amount),feeMinor:toMinor(message.fee),currency:message.currency,date:transaction?.transactionDate ?? message.occurredAt.slice(0,10),occurredAt:message.occurredAt,
      description:sourceDescription(message.direction,transaction?.description,message.counterparty),category,sourceCategory:category,
      sourceId:message.id,sourceKind:"bank",sourceFingerprint:hash({message,transaction:transaction ?? null}),
      legacyTransactionId:duplicate ? null : message.transactionId,feeTransactionId:duplicate ? null : message.feeTransactionId,
      confirmedFeeMinor: !duplicate && feeTransaction?.status === "active" && feeTransaction.type === "expense" && feeTransaction.category === "Fees" && feeTransaction.currency === message.currency && feeTransaction.sourceUpdateId === `bank:${message.id}:fee` && toMinor(feeTransaction.amount) === toMinor(message.fee) ? toMinor(message.fee) : 0,
      legacyClassification:legacyLoan.has(message.status) ? "loan" : transaction && toMinor(transaction.amount)<0 ? "refund" : null,
      reportedBalanceMinor:message.balance === null ? null : toMinor(message.balance),sourceText:message.raw,sourceLabel:message.source,
    });
  }
  for (const transaction of transactions) {
    if (transaction.userId !== ownerId || claimedTransactions.has(transaction.transactionId)) continue;
    const minor=toMinor(transaction.amount);
    if (minor===0) continue;
    const status:MovementStatus=transaction.status === "active" ? "confirmed" : "excluded";
    const direction=transaction.type === "income" || minor<0 ? "in" : "out";
    rows.push({id:`transaction:${transaction.transactionId}`,ownerId,accountId:null,direction,status,sourceStatus:status,
      amountMinor:Math.abs(minor),feeMinor:0,currency:transaction.currency,date:transaction.transactionDate,occurredAt:null,
      description:sourceDescription(direction,transaction.description),category:transaction.category,sourceCategory:transaction.category,
      sourceId:transaction.transactionId,sourceKind:"transaction",sourceFingerprint:hash(transaction),legacyTransactionId:transaction.transactionId,feeTransactionId:null,legacyClassification:minor<0 ? "refund" : null,sourceLabel:transaction.paymentMethod || "Manual / cash"});
  }
  return rows;
}

/** Refresh raw evidence, retain explicit classifications only while their fingerprints are current. */
export function hydrateAccountingSources(saved:AccountingState,fresh:CashMovement[]):AccountingState {
  const prior = new Map(saved.movements.map((row) => [row.id,row]));
  const freshIds=new Set(fresh.map((row) => row.id));
  const movements = fresh.map((source) => {
    const old=prior.get(source.id);
    if (!old) return source;
    const accountId=old.accountId && saved.accounts.some((account) => account.id === old.accountId && account.currency === source.currency) ? old.accountId : source.accountId;
    return {...source,accountId,...(old.sourceFingerprint===source.sourceFingerprint ? {status:old.status,category:old.category,
      ...(old.categoryOrigin===undefined ? {} : {categoryOrigin:old.categoryOrigin}),
      ...(old.appliedRuleId===undefined ? {} : {appliedRuleId:old.appliedRuleId}),
      ...(old.ruleConflict===undefined ? {} : {ruleConflict:old.ruleConflict})} : {})};
  });
  // Removed sources remain visible as stale audit evidence, with no report or snapshot effect.
  for (const old of saved.movements) if (!freshIds.has(old.id)) movements.push({...old,status:"excluded",sourceStatus:"excluded",sourceMissing:true,sourceFingerprint:old.sourceMissing ? old.sourceFingerprint : hash({missing:old.id,previous:old.sourceFingerprint})});
  for (const transfer of saved.transfers) {
    if (!transfer.automatic) continue;
    const outgoing = movements.find((row) => row.id === transfer.outgoing.movementId), incoming = movements.find((row) => row.id === transfer.incoming.movementId);
    const current = outgoing && incoming && !outgoing.sourceMissing && !incoming.sourceMissing && outgoing.sourceFingerprint === transfer.outgoing.sourceFingerprint && incoming.sourceFingerprint === transfer.incoming.sourceFingerprint && outgoing.accountId && incoming.accountId && outgoing.accountId !== incoming.accountId && outgoing.direction === "out" && incoming.direction === "in" && outgoing.currency === incoming.currency && outgoing.amountMinor === incoming.amountMinor;
    if (current) continue;
    for (const [movement, previous] of [[outgoing, transfer.automatic.outgoing], [incoming, transfer.automatic.incoming]] as const) {
      // A later user classification wins. Only the stale automatic exclusion is invalidated.
      if (movement?.status === "transfer" && movement.sourceStatus === "transfer" && !movement.sourceMissing) {
        movement.status = previous.movementStatus === "transfer" ? "review" : previous.movementStatus;
        movement.automaticTransferStale = true;
      }
    }
  }
  const snapshots=[...saved.snapshots];
  for (const movement of movements) {
    if (!movement.accountId || movement.occurredAt===null || movement.reportedBalanceMinor===undefined || movement.reportedBalanceMinor===null || !freshIds.has(movement.id)) continue;
    const id=`source-snapshot:${movement.id}:${movement.sourceFingerprint}:${movement.accountId}`;
    if (!snapshots.some((snapshot) => snapshot.id===id)) snapshots.push({id,accountId:movement.accountId,balanceMinor:movement.reportedBalanceMinor,occurredAt:movement.occurredAt,sourceId:movement.sourceId,sourceMovementId:movement.id,sourceFingerprint:movement.sourceFingerprint});
  }
  return {...saved,movements,snapshots};
}
