import { createHash } from "node:crypto";
import type { SupabaseSettings } from "@/lib/config";
import { canonicalizeAmount, toMinor } from "@/lib/finance/money";
import type { TransactionRecord } from "@/lib/finance/types";
import { hydrateAccountingSources, sourceMovements } from "@/lib/finance/accounting/sources";
import { stableJson } from "@/lib/finance/accounting/reducer";
import { emptyAccountingState, type CashMovement, type FinancialAccount, type TransferLink } from "@/lib/finance/accounting/types";
import { query } from "@/lib/supabase/connection";
import type { BankMessage } from "./store";
import type { OwnTransferNotice } from "./own-transfers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type JsonRow = Record<string, unknown>;
type Projection = {
  owner_id: string; state_owner: string; links: TransferLink[] | null; movements: CashMovement[] | null;
  accounts: FinancialAccount[] | null; bank_rows: JsonRow[] | null; transactions: JsonRow[] | null;
  overlapping_links: boolean; settlement_conflict: boolean; duplicate_principal: boolean;
};
const iso = (value: unknown) => new Date(value as string | Date).toISOString();
const text = (value: unknown) => typeof value === "string" ? value : "";
const nullableText = (value: unknown) => value === null || value === undefined ? null : text(value);

function bankMessage(row: JsonRow): BankMessage {
  return {
    id: text(row.id), ownerId: text(row.owner_id), source: row.source as BankMessage["source"],
    channel: row.channel as BankMessage["channel"], externalId: nullableText(row.external_id),
    direction: row.direction as BankMessage["direction"], kind: row.kind as BankMessage["kind"],
    amount: Number(row.amount).toFixed(2), fee: Number(row.fee).toFixed(2), currency: text(row.currency),
    counterparty: text(row.counterparty), balance: row.balance == null ? null : Number(row.balance).toFixed(2),
    occurredAt: iso(row.occurred_at), status: row.status as BankMessage["status"],
    transactionId: nullableText(row.transaction_id), feeTransactionId: nullableText(row.fee_transaction_id),
    askedAt: row.asked_at ? iso(row.asked_at) : null, raw: text(row.raw), readBy: (row.read_by ?? "rules") as BankMessage["readBy"],
  };
}

/** Match the ordinary finance adapter exactly: the principal participates in
 * the bank source fingerprint, including its row number and canonical money. */
function transaction(row: JsonRow): TransactionRecord {
  const raw = text(row.amount), negative = raw.trim().startsWith("-");
  const amount = canonicalizeAmount(negative ? raw.trim().slice(1) : raw);
  if (!amount) throw Error("Invalid projected principal.");
  return {
    transactionId: text(row.transaction_id), createdAt: iso(row.created_at), transactionDate: text(row.transaction_date),
    userId: text(row.owner_id), type: row.type as TransactionRecord["type"], amount: negative ? `-${amount}` : amount,
    currency: text(row.currency).trim(), category: text(row.category), description: text(row.description),
    paymentMethod: text(row.payment_method), notes: text(row.notes), status: row.status as TransactionRecord["status"],
    updatedAt: iso(row.updated_at), sourceUpdateId: text(row.source_update_id), rowNumber: Number(row.id),
  };
}

/** One statement gives the stored link and its exact current sources a coherent
 * database snapshot. No audit, unrelated movement, import archive, account-rule
 * or provider inference is fetched. Invalid/missing evidence returns no claim. */
export async function loadStoredOwnTransferNotice(
  settings: SupabaseSettings, ownerId: string, bankId: string,
  options: { execute?: typeof query } = {},
): Promise<OwnTransferNotice | null> {
  if (!UUID.test(ownerId) || !UUID.test(bankId)) return null;
  const target = `bank:${bankId.toLowerCase()}`;
  const rows = await (options.execute ?? query)<Projection>(settings, `with saved as (
      select owner_id,state from public.accounting_states where owner_id=$1::uuid
    ), chosen as (
      select s.owner_id,s.state,l.value as link from saved s
      cross join lateral jsonb_array_elements(coalesce(s.state->'transfers','[]'::jsonb)) l(value)
      where l.value->'outgoing'->>'movementId'=$2 or l.value->'incoming'->>'movementId'=$2 limit 2
    ), refs as (
      select link->'outgoing'->>'movementId' as id from chosen union select link->'incoming'->>'movementId' from chosen
    ), moves as (
      select m.value as movement from saved s cross join lateral jsonb_array_elements(coalesce(s.state->'movements','[]'::jsonb)) m(value)
      where m.value->>'id' in (select id from refs) limit 3
    ), accounts as (
      select a.value as account from saved s cross join lateral jsonb_array_elements(coalesce(s.state->'accounts','[]'::jsonb)) a(value)
      where a.value->>'id' in (select movement->>'accountId' from moves) limit 3
    ), banks as (
      select b.* from public.bank_messages b where b.owner_id=$1::uuid and 'bank:'||b.id::text in (select id from refs)
    ), principals as (
      select t.* from public.transactions t where t.owner_id=$1::uuid and
      (t.transaction_id in (select transaction_id from banks) or t.transaction_id in (select fee_transaction_id from banks))
    ) select s.owner_id::text,s.state->>'ownerId' as state_owner,
      (select jsonb_agg(link) from chosen) as links,
      (select jsonb_agg(movement) from moves) as movements,
      (select jsonb_agg(account) from accounts) as accounts,
      (select jsonb_agg(jsonb_build_object('id',b.id::text,'owner_id',b.owner_id::text,'source',b.source,'channel',b.channel,
        'external_id',b.external_id,'direction',b.direction,'kind',b.kind,'amount',b.amount::text,'fee',b.fee::text,
        'currency',b.currency,'counterparty',b.counterparty,'balance',b.balance::text,'occurred_at',b.occurred_at,
        'status',b.status,'transaction_id',b.transaction_id::text,'fee_transaction_id',b.fee_transaction_id::text,
        'asked_at',b.asked_at,'raw',b.raw,'read_by',b.read_by)) from banks b) as bank_rows,
      (select jsonb_agg(jsonb_build_object('id',t.id::text,'owner_id',t.owner_id::text,'transaction_id',t.transaction_id::text,
        'created_at',t.created_at,'transaction_date',t.transaction_date::text,'type',t.type,'amount',t.amount::text,
        'currency',t.currency,'category',t.category,'description',t.description,'payment_method',t.payment_method,
        'notes',t.notes,'status',t.status,'updated_at',t.updated_at,'source_update_id',t.source_update_id)) from principals t) as transactions,
      (select count(*)>1 from jsonb_array_elements(coalesce(s.state->'transfers','[]'::jsonb)) l(value)
        where l.value->'outgoing'->>'movementId' in (select id from refs) or l.value->'incoming'->>'movementId' in (select id from refs)) as overlapping_links,
      exists(select 1 from jsonb_array_elements(coalesce(s.state->'settlements','[]'::jsonb)) l(value)
        where l.value->'original'->>'movementId' in (select id from refs) or exists(
          select 1 from jsonb_array_elements(coalesce(l.value->'returns','[]'::jsonb)) r(value) where r.value->>'movementId' in (select id from refs))) as settlement_conflict,
      exists(select 1 from public.bank_messages other where other.owner_id=$1::uuid
        and other.id not in (select id from banks) and other.transaction_id in (select transaction_id from banks)) as duplicate_principal
    from saved s where exists(select 1 from chosen)`, [ownerId, target]);
  return noticeFromProjection(ownerId, bankId.toLowerCase(), rows[0]);
}

function noticeFromProjection(ownerId: string, bankId: string, row: Projection | undefined): OwnTransferNotice | null {
  try {
    if (!row || row.owner_id !== ownerId || row.state_owner !== ownerId || row.overlapping_links || row.settlement_conflict || row.duplicate_principal ||
        !Array.isArray(row.links) || row.links.length !== 1 || !Array.isArray(row.movements) || row.movements.length !== 2 ||
        !Array.isArray(row.accounts) || row.accounts.length !== 2 || !Array.isArray(row.bank_rows) || row.bank_rows.length !== 2) return null;
    const link = row.links[0];
    if (!link || !link.id || !link.outgoing?.movementId || !link.incoming?.movementId || link.outgoing.movementId === link.incoming.movementId) return null;
    const saved = { ...emptyAccountingState(ownerId), accounts: row.accounts, movements: row.movements, transfers: [link] };
    if (new Set(saved.movements.map(item => item.id)).size !== 2 || new Set(saved.accounts.map(item => item.id)).size !== 2 ||
        saved.movements.some(item => item.ownerId !== ownerId || item.sourceKind !== "bank" || item.sourceMissing || item.automaticTransferStale)) return null;
    const messages = row.bank_rows.map(bankMessage), transactions = (row.transactions ?? []).map(transaction);
    if (messages.some(message => message.ownerId !== ownerId || !["payment", "transfer_own", "unknown"].includes(message.kind) || !["needs_label", "transfer", "recorded", "matched"].includes(message.status)) ||
        new Set(messages.map(message => message.id)).size !== 2 || transactions.some(item => item.userId !== ownerId)) return null;
    const fresh = sourceMovements(ownerId, transactions, messages);
    const current = hydrateAccountingSources(saved, fresh);
    const outgoing = current.movements.find(item => item.id === link.outgoing.movementId), incoming = current.movements.find(item => item.id === link.incoming.movementId);
    if (!outgoing || !incoming || outgoing.sourceMissing || incoming.sourceMissing || outgoing.ownerId !== ownerId || incoming.ownerId !== ownerId ||
        outgoing.direction !== "out" || incoming.direction !== "in" || outgoing.status !== "transfer" || incoming.status !== "transfer" ||
        outgoing.sourceFingerprint !== link.outgoing.sourceFingerprint || incoming.sourceFingerprint !== link.incoming.sourceFingerprint ||
        outgoing.amountMinor <= 0 || outgoing.amountMinor !== incoming.amountMinor || outgoing.currency !== incoming.currency ||
        outgoing.legacyClassification || incoming.legacyClassification || !outgoing.accountId || !incoming.accountId || outgoing.accountId === incoming.accountId) return null;
    const out = messages.find(message => message.id === outgoing.sourceId), received = messages.find(message => message.id === incoming.sourceId);
    const from = current.accounts.find(account => account.id === outgoing.accountId && account.currency === outgoing.currency), to = current.accounts.find(account => account.id === incoming.accountId && account.currency === incoming.currency);
    if (!out || !received || !from || !to || typeof from.label !== "string" || typeof to.label !== "string" ||
        out.direction !== "out" || received.direction !== "in" || out.currency !== received.currency || out.currency !== outgoing.currency ||
        toMinor(out.amount) !== outgoing.amountMinor || toMinor(received.amount) !== outgoing.amountMinor || ![out.id, received.id].includes(bankId)) return null;
    return {
      state: "paired", ownerId, pairId: link.id, outgoingBankMessageId: out.id, incomingBankMessageId: received.id,
      amount: (outgoing.amountMinor / 100).toFixed(2), currency: outgoing.currency,
      fromAccount: { id: from.id, label: from.label }, toAccount: { id: to.id, label: to.label },
      evidenceFingerprint: createHash("sha256").update(stableJson([out.id, outgoing.sourceFingerprint, received.id, incoming.sourceFingerprint, from.id, to.id])).digest("hex"),
    };
  } catch { return null; }
}
