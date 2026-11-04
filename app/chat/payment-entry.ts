import { createHash } from "node:crypto";
import type { ChatMessageRecord } from "@/lib/accounts/messages";
import type { SupabaseSettings } from "@/lib/config";
import { formatAmount } from "@/lib/finance/money";
import { paymentActivityMention, type MentionCandidate } from "@/lib/bank/notices";
import type { BankMessage } from "@/lib/bank/store";
import { loadOwnTransferNotice } from "@/lib/bank/own-transfers";
import { query } from "@/lib/supabase/connection";
import { paymentLinkId } from "./payment-link";

export type PaymentChatEntry =
  | { state: "ready"; bankMessageId: string; message: ChatMessageRecord }
  | { state: "unavailable" };

type EntryRow = {
  id: string; owner_id: string; channel: BankMessage["channel"]; direction: BankMessage["direction"];
  kind: BankMessage["kind"]; amount: string; fee: string; currency: string; counterparty: string;
  occurred_at: Date | string; created_at: Date | string; status: BankMessage["status"];
  transaction_id: string | null; fee_transaction_id: string | null; read_by: BankMessage["readBy"];
  purpose_owner_id: string | null; purpose_transaction_id: string | null; purpose_category: string | null;
  purpose_description: string | null; purpose_record_status: string | null;
  principal_type: string | null; principal_amount: string | null; principal_currency: string | null;
  message_id: string | null; message_created_at: Date | string | null;
};
type Read = typeof query;
const iso = (value: Date | string) => new Date(value).toISOString();

/** Explicit notification navigation is a read, never an announcement replay or
 * classification. A current, deterministic view also covers push arriving
 * before its durable Chat notice, and stale notices whose source has changed.
 * The query deliberately excludes raw SMS and subscription/credential data. */
export async function loadPaymentChatEntry(
  settings: SupabaseSettings, ownerId: string, requestedId: unknown,
  options: { execute?: Read; loadTransfer?: typeof loadOwnTransferNotice } = {},
): Promise<PaymentChatEntry> {
  const id = paymentLinkId(requestedId);
  if (!id) return { state: "unavailable" };
  const clientId = `bank_notice_${createHash("sha256").update(`${ownerId}\0${id}`).digest("hex")}`;
  const rows = await (options.execute ?? query)<EntryRow>(settings, `select
    b.id::text,b.owner_id::text,b.channel,b.direction,b.kind,b.amount::text,b.fee::text,b.currency,b.counterparty,
    b.occurred_at,b.created_at,b.status,b.transaction_id::text,b.fee_transaction_id::text,b.read_by,
    t.owner_id::text as purpose_owner_id,t.transaction_id::text as purpose_transaction_id,
    t.category as purpose_category,t.description as purpose_description,t.status as purpose_record_status,
    t.type as principal_type,t.amount::text as principal_amount,t.currency as principal_currency,
    m.id::text as message_id,m.created_at as message_created_at
    from public.bank_messages b
    left join public.transactions t on t.owner_id=b.owner_id and t.transaction_id=b.transaction_id and t.status='active'
    left join public.messages m on m.owner_id=b.owner_id and m.client_id=$3 and m.role='assistant'
    where b.owner_id=$1::uuid and b.id=$2::uuid limit 1`, [ownerId, id, clientId]);
  const row = rows[0];
  if (!row || row.owner_id !== ownerId || row.id.toLowerCase() !== id || !["mac", "shortcut"].includes(row.channel)) return { state: "unavailable" };
  const candidate: MentionCandidate = {
    id, ownerId, channel: row.channel, direction: row.direction, kind: row.kind,
    amount: row.amount, fee: row.fee, currency: row.currency, counterparty: row.counterparty,
    occurredAt: iso(row.occurred_at), createdAt: iso(row.created_at), status: row.status,
    transactionId: row.transaction_id, feeTransactionId: row.fee_transaction_id, readBy: row.read_by,
    principalType: row.principal_type, principalAmount: row.principal_amount, principalCurrency: row.principal_currency,
    purpose: row.purpose_owner_id && row.purpose_transaction_id ? {
      ownerId: row.purpose_owner_id, transactionId: row.purpose_transaction_id,
      category: row.purpose_category ?? "", description: row.purpose_description ?? "", recordStatus: row.purpose_record_status ?? "",
    } : null,
    transfer: await (options.loadTransfer ?? loadOwnTransferNotice)(settings, ownerId, id).catch(() => null),
  };
  const mention = paymentActivityMention(candidate);
  let body = mention?.body;
  if (!body) {
    let amount: string;
    try { amount = formatAmount(row.amount, row.currency); } catch { return { state: "unavailable" }; }
    body = row.status === "skipped"
      ? `This ${amount} payment alert is currently set aside. I haven't added it as income or spending.`
      : `Here is the ${amount} payment alert you opened. Its status has changed, so I won't use the old question to classify it. Tell me what you'd like to check.`;
  }
  return {
    state: "ready", bankMessageId: id,
    message: {
      id: row.message_id ?? clientId, clientId, role: "assistant", channel: "web", body,
      createdAt: iso(row.message_created_at ?? row.created_at), intent: mention?.intent ?? "automation:incoming-payment",
      // Opening a notification does not itself mutate the ledger.
      ledgerChanged: false,
      paymentNotice: { bankMessageId: id, requiresPurpose: mention?.requiresPurpose ?? false },
    },
  };
}

/** Include an old target outside the normal history window once, retaining its
 * source position rather than copying an old question to the end of Chat. */
export function includePaymentChatEntry(history: ChatMessageRecord[], entry: PaymentChatEntry | null): ChatMessageRecord[] {
  if (entry?.state !== "ready") return history;
  const message = entry.message;
  return [...history.filter(item => item.id !== message.id && !(item.role === "assistant" && item.clientId === message.clientId)), message]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}
