import { createHash, randomBytes } from "node:crypto";

import type { SupabaseSettings } from "@/lib/config";
import { query } from "@/lib/supabase/connection";
import type { BankSource } from "@/lib/bank/parse";
import type { MemoryNotebookStore } from "@/lib/notebook/store";

export type BankStatus = "needs_label" | "recorded" | "matched" | "transfer" | "loan" | "skipped" | "lent" | "repaid" | "borrowed" | "paid_back";
/**
 * `card_hold` is a card payment the bank put on hold; it counts as spent.
 * `hold_settle` is a later debit that may be that payment going through, asked about before it counts.
 */
export type BankKind = "payment" | "transfer_own" | "loan_in" | "unknown" | "loan_out" | "loan_repay" | "card_hold" | "hold_settle";

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
  /** Whether Alfred's own rules read the text, or the model did because no rule fit. */
  readBy: "rules" | "model";
};

export type NewBankMessage = Omit<BankMessage, "id" | "transactionId" | "feeTransactionId" | "askedAt" | "readBy"> & { textHash: string; readBy?: BankMessage["readBy"] };

export type BankBalance = { source: BankSource; balance: string; at: string };

/** What a payee means: a category, or someone chipping in toward bills in that category. */
export type PayeeRule = { payeeKey: string; category: string; description: string; kind?: "category" | "chip_in" };

/** One thing a label changed, recorded so "undo" can put it back. */
export type LabelChange = {
  messageId: string;
  previous: { status: BankStatus; kind: BankKind };
  transactionIds: string[];
  loanId?: string;
  /** A card hold this payment was confirmed to be, so undo can put the hold back. */
  heldId?: string;
  /** What the payment was filed as, like "Transport" or "paying you back", so a correction can refer to it. */
  filedAs?: string;
  rule?: { payeeKey: string; previous: PayeeRule | null };
};

export interface BankStore {
  /** Inserts a message, or returns null when the same message was already stored. */
  insertMessage(row: NewBankMessage): Promise<BankMessage | null>;
  updateMessage(ownerId: string, id: string, patch: Partial<Pick<BankMessage, "status" | "transactionId" | "feeTransactionId" | "askedAt" | "kind" | "balance">>): Promise<void>;
  getMessage(ownerId: string, id: string): Promise<BankMessage | null>;
  /** Corrects the date of a stored message that still needs a label, when a later copy shows when it really happened. */
  correctDate(ownerId: string, textHash: string, occurredAt: string): Promise<void>;
  listMessages(ownerId: string, status?: BankStatus): Promise<BankMessage[]>;
  /** Messages that happened between two instants (inclusive), oldest first. */
  listBetween(ownerId: string, from: string, to: string): Promise<BankMessage[]>;
  /** Ledger transaction ids already linked to a bank message, so one manual entry isn't matched twice. */
  linkedTransactionIds(ownerId: string): Promise<Set<string>>;
  getRule(ownerId: string, payeeKey: string): Promise<PayeeRule | null>;
  saveRule(ownerId: string, rule: PayeeRule): Promise<void>;
  accountNames(ownerId: string): Promise<string[]>;
  /** Remembers another name on the person's own accounts. */
  addAccountName(ownerId: string, name: string): Promise<void>;
  /** Last digits of accounts whose texts aren't the person's money, from their notebook. */
  ignoredAccounts(ownerId: string): Promise<string[]>;
  /** The newest balance each source reported, leaving out ignored accounts. */
  latestBalances(ownerId: string): Promise<BankBalance[]>;
  deleteRule(ownerId: string, payeeKey: string): Promise<void>;
  /** Keeps the latest batch of label changes, replacing the one before. */
  saveUndo(ownerId: string, changes: LabelChange[]): Promise<void>;
  /** Hands back the latest batch, if it's recent, and forgets it. */
  takeUndo(ownerId: string, since: Date): Promise<LabelChange[] | null>;
  /** The last batch of labels, if applied since `since`, without clearing it. */
  peekUndo(ownerId: string, since: Date): Promise<LabelChange[] | null>;
  /**
   * Marks forwarded messages as announced and returns them, but only once
   * none has arrived for `quietMs`, so a burst of texts gets one summary.
   */
  claimUnannounced(ownerId: string, quietMs: number): Promise<BankMessage[]>;
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
  read_by: BankMessage["readBy"];
};

const columns = `id, owner_id, source, channel, external_id, direction, kind, amount::text, fee::text, currency, counterparty,
  balance::text, occurred_at, status, transaction_id::text, fee_transaction_id::text, asked_at, raw, read_by`;

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
    readBy: row.read_by ?? "rules",
  };
}

export function createSupabaseBankStore(settings: SupabaseSettings): BankStore {
  return {
    async insertMessage(row) {
      const rows = await query<MessageRow>(
        settings,
        `insert into public.bank_messages
           (owner_id, source, channel, external_id, text_hash, direction, kind, amount, fee, currency, counterparty, balance, occurred_at, status, raw, read_by)
         values ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         on conflict do nothing
         returning ${columns}`,
        [
          row.ownerId, row.source, row.channel, row.externalId, row.textHash, row.direction, row.kind, row.amount, row.fee,
          row.currency, row.counterparty, row.balance, row.occurredAt, row.status, row.raw.slice(0, 1200), row.readBy ?? "rules",
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
      if (patch.balance !== undefined) add("balance", patch.balance);
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
    async listBetween(ownerId, from, to) {
      const rows = await query<MessageRow>(
        settings,
        `select ${columns} from public.bank_messages
         where owner_id = $1::uuid and occurred_at between $2 and $3
         order by occurred_at, created_at`,
        [ownerId, from, to],
      );
      return rows.map(fromRow);
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
      const rows = await query<{ payee_key: string; category: string; description: string; kind: "category" | "chip_in" }>(
        settings,
        "select payee_key, category, description, kind from public.payee_rules where owner_id = $1::uuid and payee_key = $2",
        [ownerId, payeeKey],
      );
      return rows[0] ? { payeeKey: rows[0].payee_key, category: rows[0].category, description: rows[0].description, kind: rows[0].kind } : null;
    },
    async saveRule(ownerId, rule) {
      await query(
        settings,
        `insert into public.payee_rules (owner_id, payee_key, category, description, kind) values ($1::uuid, $2, $3, $4, $5)
         on conflict (owner_id, payee_key) do update set category = excluded.category, description = excluded.description, kind = excluded.kind, updated_at = now()`,
        [ownerId, rule.payeeKey, rule.category, rule.description, rule.kind ?? "category"],
      );
    },
    async accountNames(ownerId) {
      const rows = await query<{ account_names: string }>(settings, "select account_names from public.profiles where id = $1::uuid", [ownerId]);
      return splitNames(rows[0]?.account_names ?? "");
    },
    async deleteRule(ownerId, payeeKey) {
      await query(settings, "delete from public.payee_rules where owner_id = $1::uuid and payee_key = $2", [ownerId, payeeKey]);
    },
    async saveUndo(ownerId, changes) {
      await query(
        settings,
        `insert into public.label_undo (owner_id, changes) values ($1::uuid, $2::jsonb)
         on conflict (owner_id) do update set changes = excluded.changes, created_at = now()`,
        [ownerId, JSON.stringify(changes)],
      );
    },
    async takeUndo(ownerId, since) {
      const rows = await query<{ changes: LabelChange[] }>(
        settings,
        "delete from public.label_undo where owner_id = $1::uuid returning changes, created_at >= $2 as fresh",
        [ownerId, since.toISOString()],
      );
      const row = rows[0] as { changes: LabelChange[]; fresh?: boolean } | undefined;
      return row?.fresh ? row.changes : null;
    },
    async peekUndo(ownerId, since) {
      const rows = await query<{ changes: LabelChange[] }>(settings, "select changes from public.label_undo where owner_id = $1::uuid and created_at >= $2", [
        ownerId,
        since.toISOString(),
      ]);
      return rows[0]?.changes ?? null;
    },
    async claimUnannounced(ownerId, quietMs) {
      const rows = await query<MessageRow>(
        settings,
        `update public.bank_messages set announced_at = now()
         where owner_id = $1::uuid and announced_at is null and channel in ('shortcut', 'mac')
           and not exists (
             select 1 from public.bank_messages recent
             where recent.owner_id = $1::uuid and recent.announced_at is null and recent.channel in ('shortcut', 'mac')
               and recent.created_at > now() - make_interval(secs => $2::double precision / 1000)
           )
         returning ${columns}`,
        [ownerId, quietMs],
      );
      return rows.map(fromRow).sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
    },
    async ignoredAccounts(ownerId) {
      const rows = await query<{ account: string }>(settings, "select account from public.about_me where owner_id = $1::uuid and account is not null", [ownerId]);
      return rows.map((row) => row.account);
    },
    async latestBalances(ownerId) {
      const rows = await query<{ source: BankSource; balance: string; occurred_at: Date }>(
        settings,
        `select distinct on (source) source, balance::text, occurred_at
         from public.bank_messages
         where owner_id = $1::uuid and balance is not null
         order by source, occurred_at desc, created_at desc`,
        [ownerId],
      );
      return rows.map((row) => ({ source: row.source, balance: Number(row.balance).toFixed(2), at: row.occurred_at.toISOString() }));
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
  /** The person's notebook, whose account notes say which accounts to ignore. */
  notebook: MemoryNotebookStore | null = null;
  undo: { changes: LabelChange[]; at: Date } | null = null;
  announced = new Set<string>();

  async insertMessage(row: NewBankMessage) {
    const duplicate = this.messages.some(
      (item) =>
        item.ownerId === row.ownerId &&
        (item.textHash === row.textHash || (row.externalId && item.externalId === row.externalId && item.source === row.source)),
    );
    if (duplicate) return null;
    const message = { ...row, readBy: row.readBy ?? "rules", id: `00000000-0000-4000-9000-${String(this.messages.length + 1).padStart(12, "0")}`, transactionId: null, feeTransactionId: null, askedAt: null };
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
  async listBetween(ownerId: string, from: string, to: string) {
    return this.messages
      .filter((item) => item.ownerId === ownerId && item.occurredAt >= from && item.occurredAt <= to)
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
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
  async deleteRule(_ownerId: string, payeeKey: string) {
    this.rules.delete(payeeKey);
  }
  async ignoredAccounts() {
    return (this.notebook?.notes ?? []).flatMap((item) => (item.account ? [item.account] : []));
  }
  async latestBalances(ownerId: string) {
    const newest = new Map<BankSource, BankBalance>();
    for (const item of this.messages.filter((message) => message.ownerId === ownerId && message.balance !== null)) {
      const current = newest.get(item.source);
      if (!current || item.occurredAt >= current.at) newest.set(item.source, { source: item.source, balance: item.balance!, at: item.occurredAt });
    }
    return [...newest.values()];
  }
  async saveUndo(_ownerId: string, changes: LabelChange[]) {
    this.undo = { changes, at: new Date() };
  }
  async takeUndo(_ownerId: string, since: Date) {
    const undo = this.undo;
    this.undo = null;
    return undo && undo.at >= since ? undo.changes : null;
  }
  async peekUndo(_ownerId: string, since: Date) {
    return this.undo && this.undo.at >= since ? this.undo.changes : null;
  }
  async claimUnannounced(ownerId: string) {
    const fresh = this.messages.filter((item) => item.ownerId === ownerId && !this.announced.has(item.id) && (item.channel === "shortcut" || item.channel === "mac"));
    for (const item of fresh) this.announced.add(item.id);
    return fresh.map((item) => ({ ...item })).sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
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
