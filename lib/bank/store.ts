import { createHash, randomBytes } from "node:crypto";

import type { SupabaseSettings } from "@/lib/config";
import { query } from "@/lib/supabase/connection";
import type { BankSource } from "@/lib/bank/parse";

export type BankStatus = "needs_label" | "recorded" | "matched" | "transfer" | "loan" | "skipped";
export type BankKind = "payment" | "transfer_own" | "loan_in" | "unknown";

export type BankMessage = {
  id: string;
  ownerId: string;
  source: BankSource;
  channel: "shortcut" | "screenshot" | "manual" | "mac";
  externalId: string | null;
  direction: "in" | "out";
  kind: BankKind;
  amount: string;
  fee: string;
  currency: string;
  counterparty: string;
  balance: string | null;
  occurredAt: string;
  status: BankStatus;
  transactionId: string | null;
  feeTransactionId: string | null;
  askedAt: string | null;
  raw: string;
};

export type NewBankMessage = Omit<BankMessage, "id" | "transactionId" | "feeTransactionId" | "askedAt"> & { textHash: string };

export type PayeeRule = { payeeKey: string; category: string; description: string };

export interface BankStore {
  /** Inserts a message, or returns null when the same message was already stored. */
  insertMessage(row: NewBankMessage): Promise<BankMessage | null>;
  updateMessage(ownerId: string, id: string, patch: Partial<Pick<BankMessage, "status" | "transactionId" | "feeTransactionId" | "askedAt" | "kind">>): Promise<void>;
  getMessage(ownerId: string, id: string): Promise<BankMessage | null>;
  /** Corrects the date of a stored message that still needs a label, when a later copy shows when it really happened. */
  correctDate(ownerId: string, textHash: string, occurredAt: string): Promise<void>;
  listMessages(ownerId: string, status?: BankStatus): Promise<BankMessage[]>;
  /** Ledger transaction ids already linked to a bank message, so one manual entry isn't matched twice. */
  linkedTransactionIds(ownerId: string): Promise<Set<string>>;
  getRule(ownerId: string, payeeKey: string): Promise<PayeeRule | null>;
  saveRule(ownerId: string, rule: PayeeRule): Promise<void>;
  accountNames(ownerId: string): Promise<string[]>;
  /** Remembers another name on the person's own accounts. */
  addAccountName(ownerId: string, name: string): Promise<void>;
}

type MessageRow = {
  id: string;
  owner_id: string;
  source: BankSource;
  channel: BankMessage["channel"];
  external_id: string | null;
  direction: "in" | "out";
  kind: BankKind;
  amount: string;
  fee: string;
  currency: string;
  counterparty: string;
  balance: string | null;
  occurred_at: Date;
  status: BankStatus;
  transaction_id: string | null;
  fee_transaction_id: string | null;
  asked_at: Date | null;
  raw: string;
};

const columns = `id, owner_id, source, channel, external_id, direction, kind, amount::text, fee::text, currency, counterparty,
  balance::text, occurred_at, status, transaction_id::text, fee_transaction_id::text, asked_at, raw`;

function fromRow(row: MessageRow): BankMessage {
  return {
    id: row.id,
    ownerId: row.owner_id,
    source: row.source,
    channel: row.channel,
    externalId: row.external_id,
    direction: row.direction,
    kind: row.kind,
    amount: Number(row.amount).toFixed(2),
    fee: Number(row.fee).toFixed(2),
    currency: row.currency,
    counterparty: row.counterparty,
    balance: row.balance == null ? null : Number(row.balance).toFixed(2),
    occurredAt: row.occurred_at.toISOString(),
    status: row.status,
    transactionId: row.transaction_id,
    feeTransactionId: row.fee_transaction_id,
    askedAt: row.asked_at ? row.asked_at.toISOString() : null,
    raw: row.raw,
  };
}

export function createSupabaseBankStore(settings: SupabaseSettings): BankStore {
  return {
    async insertMessage(row) {
      const rows = await query<MessageRow>(
        settings,
        `insert into public.bank_messages
           (owner_id, source, channel, external_id, text_hash, direction, kind, amount, fee, currency, counterparty, balance, occurred_at, status, raw)
         values ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         on conflict do nothing
         returning ${columns}`,
        [
          row.ownerId, row.source, row.channel, row.externalId, row.textHash, row.direction, row.kind, row.amount, row.fee,
          row.currency, row.counterparty, row.balance, row.occurredAt, row.status, row.raw.slice(0, 1200),
        ],
      );
      return rows[0] ? fromRow(rows[0]) : null;
    },
    async updateMessage(ownerId, id, patch) {
      const sets: string[] = [];
      const values: unknown[] = [ownerId, id];
      const add = (column: string, value: unknown) => {
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      };
      if (patch.status) add("status", patch.status);
      if (patch.kind) add("kind", patch.kind);
      if (patch.transactionId !== undefined) add("transaction_id", patch.transactionId);
      if (patch.feeTransactionId !== undefined) add("fee_transaction_id", patch.feeTransactionId);
      if (patch.askedAt !== undefined) add("asked_at", patch.askedAt);
      if (sets.length === 0) return;
      await query(settings, `update public.bank_messages set ${sets.join(", ")} where owner_id = $1::uuid and id = $2::uuid`, values);
    },
    async correctDate(ownerId, textHash, occurredAt) {
      await query(
        settings,
        "update public.bank_messages set occurred_at = $3 where owner_id = $1::uuid and text_hash = $2 and status = 'needs_label'",
        [ownerId, textHash, occurredAt],
      );
    },
    async getMessage(ownerId, id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const rows = await query<MessageRow>(settings, `select ${columns} from public.bank_messages where owner_id = $1::uuid and id = $2::uuid`, [ownerId, id]);
      return rows[0] ? fromRow(rows[0]) : null;
    },
    async listMessages(ownerId, status) {
      const rows = await query<MessageRow>(
        settings,
        `select ${columns} from public.bank_messages
         where owner_id = $1::uuid ${status ? "and status = $2" : ""}
         order by occurred_at desc limit 200`,
        status ? [ownerId, status] : [ownerId],
      );
      return rows.map(fromRow);
    },
    async linkedTransactionIds(ownerId) {
      const rows = await query<{ id: string }>(
        settings,
        `select transaction_id::text as id from public.bank_messages where owner_id = $1::uuid and transaction_id is not null
         union select fee_transaction_id::text from public.bank_messages where owner_id = $1::uuid and fee_transaction_id is not null`,
        [ownerId],
      );
      return new Set(rows.map((row) => row.id));
    },
    async getRule(ownerId, payeeKey) {
      const rows = await query<{ payee_key: string; category: string; description: string }>(
        settings,
        "select payee_key, category, description from public.payee_rules where owner_id = $1::uuid and payee_key = $2",
        [ownerId, payeeKey],
      );
      return rows[0] ? { payeeKey: rows[0].payee_key, category: rows[0].category, description: rows[0].description } : null;
    },
    async saveRule(ownerId, rule) {
      await query(
        settings,
        `insert into public.payee_rules (owner_id, payee_key, category, description) values ($1::uuid, $2, $3, $4)
         on conflict (owner_id, payee_key) do update set category = excluded.category, description = excluded.description, updated_at = now()`,
        [ownerId, rule.payeeKey, rule.category, rule.description],
      );
    },
    async accountNames(ownerId) {
      const rows = await query<{ account_names: string }>(settings, "select account_names from public.profiles where id = $1::uuid", [ownerId]);
      return splitNames(rows[0]?.account_names ?? "");
    },
    async addAccountName(ownerId, name) {
      const current = await this.accountNames(ownerId);
      if (current.some((item) => item.toLowerCase() === name.trim().toLowerCase())) return;
      await query(settings, "update public.profiles set account_names = $2, updated_at = now() where id = $1::uuid", [
        ownerId,
        [...current, name.trim()].slice(0, 8).join("\n"),
      ]);
    },
  };
}

export function splitNames(value: string): string[] {
  return value
    .split(/[\n,;]+/)
    .map((name) => name.trim())
    .filter(Boolean)
    .slice(0, 8);
}

/** In-memory store for tests. */
export class MemoryBankStore implements BankStore {
  messages: (BankMessage & { textHash: string })[] = [];
  rules = new Map<string, PayeeRule>();
  names: string[] = [];

  async insertMessage(row: NewBankMessage) {
    const duplicate = this.messages.some(
      (item) =>
        item.ownerId === row.ownerId &&
        (item.textHash === row.textHash || (row.externalId && item.externalId === row.externalId && item.source === row.source)),
    );
    if (duplicate) return null;
    const message = { ...row, id: `00000000-0000-4000-9000-${String(this.messages.length + 1).padStart(12, "0")}`, transactionId: null, feeTransactionId: null, askedAt: null };
    this.messages.push(message);
    return { ...message };
  }
  async updateMessage(ownerId: string, id: string, patch: Partial<BankMessage>) {
    const message = this.messages.find((item) => item.ownerId === ownerId && item.id === id);
    if (message) Object.assign(message, patch);
  }
  async correctDate(ownerId: string, textHash: string, occurredAt: string) {
    const message = this.messages.find((item) => item.ownerId === ownerId && item.textHash === textHash && item.status === "needs_label");
    if (message) message.occurredAt = occurredAt;
  }
  async getMessage(ownerId: string, id: string) {
    const message = this.messages.find((item) => item.ownerId === ownerId && item.id === id);
    return message ? { ...message } : null;
  }
  async listMessages(ownerId: string, status?: BankStatus) {
    return this.messages
      .filter((item) => item.ownerId === ownerId && (!status || item.status === status))
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .map((item) => ({ ...item }));
  }
  async linkedTransactionIds(ownerId: string) {
    const ids = new Set<string>();
    for (const item of this.messages.filter((message) => message.ownerId === ownerId)) {
      if (item.transactionId) ids.add(item.transactionId);
      if (item.feeTransactionId) ids.add(item.feeTransactionId);
    }
    return ids;
  }
  async getRule(_ownerId: string, payeeKey: string) {
    return this.rules.get(payeeKey) ?? null;
  }
  async saveRule(_ownerId: string, rule: PayeeRule) {
    this.rules.set(rule.payeeKey, rule);
  }
  async accountNames() {
    return this.names;
  }
  async addAccountName(_ownerId: string, name: string) {
    if (!this.names.some((item) => item.toLowerCase() === name.toLowerCase())) this.names.push(name);
  }
}

/** Creates a fresh forwarding secret. Only its hash is stored. */
export function newIngestToken(): { token: string; hash: string } {
  const token = `alf_${randomBytes(24).toString("base64url")}`;
  return { token, hash: hashIngestToken(token) };
}

export function hashIngestToken(token: string): string {
  return createHash("sha256").update(token.trim()).digest("hex");
}
