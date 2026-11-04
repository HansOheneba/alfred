import { describe, expect, it, vi } from "vitest";
import type { BankMessage } from "@/lib/bank/store";
import { sourceMovements, hydrateAccountingSources } from "@/lib/finance/accounting/sources";
import { emptyAccountingState, type CashMovement } from "@/lib/finance/accounting/types";
import { buildAccountingView } from "@/lib/finance/accounting/view";
import type { TransactionRecord } from "@/lib/finance/types";
import { ALFRED_EXPORT_SNAPSHOT_SQL, buildAlfredExport, scrubNativeOwnership, type AlfredNativeExport } from "@/lib/portability/export";
import { accountingCoreFromNative, splitConfirmedBankFeesForPortability } from "@/lib/portability/native-core";
import { planImport } from "@/lib/portability/model";
import { NATIVE_TABLES, planNativeRestoration } from "@/lib/portability/native-restoration";
import { createArchive, readArchive } from "../portability/archive.mjs";

const transport = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: transport.query }));
const OWNER = "10000000-0000-4000-8000-000000000001";
const DESTINATION = "10000000-0000-4000-8000-000000000002";
const AT = "2026-11-04T12:00:00.000Z";
const uuid = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function evidence() {
  const profile = { preferred_name: "Fictional", currency: "GHS", timezone: "Africa/Accra", communication_preference: "concise", financial_goals: "", account_names: "", created_at: AT, updated_at: AT };
  const transaction = (id: string, amount: string, category: string, sourceUpdateId: string): TransactionRecord => ({ transactionId: id, userId: OWNER,
    createdAt: AT, updatedAt: AT, transactionDate: "2026-11-04", type: "expense", amount, currency: "GHS", category,
    description: "Fictional purchase or actual fee", paymentMethod: "MTN MoMo", notes: "", status: "active", sourceUpdateId, rowNumber: 1 });
  const raw = [transaction(uuid(11), "100.00", "Food", `bank:${uuid(1)}`), transaction(uuid(12), "1.00", "Fees", `bank:${uuid(1)}:fee`), transaction(uuid(13), "0.25", "Fees", `bank:${uuid(3)}:fee`)];
  const bank = (id: number, direction: "in" | "out", amount: string, status: string, fee: string, transactionId: string | null, feeTransactionId: string | null): BankMessage => ({
    id: uuid(id), ownerId: OWNER, source: "momo", channel: "mac", externalId: `fictional-${id}`, direction, kind: "payment", amount, fee, currency: "GHS",
    counterparty: "FICTIONAL MERCHANT", balance: null, occurredAt: AT, status: status as BankMessage["status"], transactionId, feeTransactionId, askedAt: null, raw: `Fictional source ${id}`, readBy: "rules",
  });
  const messages = [bank(1, "out", "100.00", "recorded", "1.00", uuid(11), uuid(12)), bank(2, "in", "30.00", "returned", "0.00", null, null), bank(3, "out", "9.00", "not_completed", "0.25", null, uuid(13))];
  const movements = sourceMovements(OWNER, raw, messages).map(movement => ({ ...movement, accountId: "wallet" }));
  const original = movements.find(movement => movement.sourceId === uuid(1))!, returned = movements.find(movement => movement.sourceId === uuid(2))!;
  const state = { ...emptyAccountingState(OWNER), accounts: [{ id: "wallet", label: "Everyday MoMo", provider: "MTN MoMo", currency: "GHS", includeInCash: true, createdAt: AT }], movements,
    settlements: [{ id: "return-link", kind: "refund" as const, original: { movementId: original.id, sourceFingerprint: original.sourceFingerprint }, returns: [{ movementId: returned.id, sourceFingerprint: returned.sourceFingerprint, principalMinor: 3000 }], createdAt: AT }] };
  const native: AlfredNativeExport = { schema: 1, tables: {
    transactions: raw.map((row, index) => ({ id: String(index + 1), transaction_id: row.transactionId, created_at: row.createdAt, transaction_date: row.transactionDate,
      type: row.type, amount: row.amount, currency: row.currency, category: row.category, description: row.description, payment_method: row.paymentMethod, notes: row.notes, status: row.status, updated_at: row.updatedAt, source_update_id: row.sourceUpdateId })),
    bankMessages: messages.map(message => ({ id: message.id, source: message.source, channel: message.channel, external_id: message.externalId, text_hash: `fixture-${message.id}`,
      direction: message.direction, kind: message.kind, amount: message.amount, fee: message.fee, currency: message.currency, counterparty: message.counterparty, balance: message.balance,
      occurred_at: message.occurredAt, status: message.status, transaction_id: message.transactionId, fee_transaction_id: message.feeTransactionId, asked_at: message.askedAt, raw: message.raw, created_at: AT, announced_at: null, read_by: message.readBy })),
    bankPaymentResolutions: [
      { id: uuid(31), bank_message_id: uuid(3), kind: "not_completed", reason: "failed", request_id: "fictional-failed-confirm", source_fingerprint: "original-failed-evidence", resolved_source_fingerprint: movements.find(movement => movement.sourceId === uuid(3))!.sourceFingerprint,
        bank_evidence_fingerprint: "post-resolution-bank-evidence", live_facts_fingerprint: "current-bank-and-fee-evidence", source_snapshot: messages[2], original_movement_id: null, original_source_fingerprint: null, principal_minor: null, settlement_id: null, accounting_revision: "1", created_at: AT, reopened_at: null },
      { id: uuid(32), bank_message_id: uuid(2), kind: "returned", reason: "returned", request_id: "fictional-return-confirm", source_fingerprint: "original-return-evidence", resolved_source_fingerprint: returned.sourceFingerprint,
        bank_evidence_fingerprint: "post-return-bank-evidence", live_facts_fingerprint: "current-original-and-return-evidence", source_snapshot: messages[1], original_movement_id: original.id, original_source_fingerprint: original.sourceFingerprint, principal_minor: "3000", settlement_id: "return-link", accounting_revision: "2", created_at: AT, reopened_at: null },
    ],
    accountingStates: [{ state: scrubNativeOwnership(state), revision: 0, updated_at: AT }], importedSources: [],
  }, settings: { profile, reminderPreferences: null }, retainedArchives: [] };
  return { native, state, raw, messages };
}

describe("payment-resolution portability", () => {
  it("exports an owner-filtered allowlist and lossless source/reason evidence without executable replay", async () => {
    const { native } = evidence();
    transport.query.mockImplementation(async (_settings, sql: string, values: unknown[]) => sql.startsWith("select table_name,")
      ? (values[0] as string[]).map(table_name => ({ table_name, ready: true })) : [{ native }]);
    const exported = await buildAlfredExport({} as never, OWNER);
    const snapshot = exported.datasets["alfred.native"];
    expect(snapshot.tables.bankPaymentResolutions).toHaveLength(2);
    expect(snapshot.tables.bankPaymentResolutions[0]).toMatchObject({ reason: "failed", source_snapshot: { raw: "Fictional source 3", status: "not_completed" } });
    expect(JSON.stringify(snapshot.tables)).not.toContain('"ownerId":');
    expect(JSON.stringify(snapshot)).not.toContain(OWNER);
    expect(ALFRED_EXPORT_SNAPSHOT_SQL).toContain("from public.bank_payment_resolutions where owner_id = $1::uuid");
    expect(ALFRED_EXPORT_SNAPSHOT_SQL).toContain("principal_minor::text");
    expect(exported.coverage.find(row => row.dataset === "alfred.native.bankPaymentResolutions")).toMatchObject({ status: "preserved", count: 2 });
    const destination: AlfredNativeExport = { schema: 1, tables: Object.fromEntries(Object.values(NATIVE_TABLES).map(table => [table.source, []])), settings: { profile: null, reminderPreferences: null }, retainedArchives: [] };
    const restored = planNativeRestoration(destination, [{ namespace: exported.namespace, native: snapshot }], "alfred:destination", AT);
    expect(restored.summary.coverage.find(row => row.dataset === "alfred.native.bankPaymentResolutions")?.reason).toContain("not replayed");
    expect(restored.summary.conflicts).toEqual([]);
    expect(Object.keys(restored.plan.tables)).not.toContain("bank_payment_resolutions");
    expect(Object.keys(restored.plan.tables)).not.toContain("bank_messages");
  });

  it("round-trips excluded no-money-moved principal, a partial return and real fees through usable accounting", async () => {
    const { native, state } = evidence();
    const core = accountingCoreFromNative(native, OWNER, "alfred:source");
    const movements = core.datasets.movements as Pick<CashMovement, "sourceId" | "status" | "amountMinor" | "feeMinor">[];
    expect(core.coverage).toEqual([]);
    expect(movements.find(movement => movement.sourceId === uuid(3))).toMatchObject({ status: "excluded", amountMinor: 900, feeMinor: 0 });
    expect(movements.find(movement => movement.sourceId === uuid(13))).toMatchObject({ status: "confirmed", amountMinor: 25, feeMinor: 0, category: "Fees" });
    expect(movements.find(movement => movement.sourceId === uuid(2))).toMatchObject({ status: "confirmed", amountMinor: 3000 });
    const archive = await readArchive(await createArchive({ sourceApp: "alfred", namespace: "alfred:source", timezone: "Africa/Accra", currency: "GHS", exportedAt: AT,
      coverage: [], datasets: { ...core.datasets, "alfred.native": scrubNativeOwnership(native) } }));
    expect((archive.datasets["alfred.native"] as AlfredNativeExport).tables.bankPaymentResolutions[1]).toMatchObject({ principal_minor: "3000", settlement_id: "return-link" });
    const imported = planImport(emptyAccountingState(DESTINATION), archive, "resolution-import", AT, "alfred:destination");
    expect(imported.conflicts).toEqual([]);
    const loaded = hydrateAccountingSources(imported.next, imported.sources);
    expect(loaded.settlements).toHaveLength(1);
    expect(buildAccountingView(loaded, "GHS").totals).toEqual({ incomeMinor: 0, spentMinor: 7125 });
    expect(buildAccountingView(loaded, "GHS").totals).toEqual(buildAccountingView(state, "GHS").totals);
    const replay = planImport(loaded, archive, "resolution-import-replay", AT, "alfred:destination");
    expect(replay.additions.movements).toBe(0);
    expect(replay.additions.settlements).toBe(0);
    expect(replay.conflicts).toEqual([]);
    expect(buildAccountingView(replay.next, "GHS").totals).toEqual({ incomeMinor: 0, spentMinor: 7125 });
    const destinationNative: AlfredNativeExport = { ...native, tables: { transactions: [], bankMessages: [], bankPaymentResolutions: [], accountingStates: [{ state: scrubNativeOwnership(loaded) }], importedSources: imported.sources.map(movement => ({ movement: scrubNativeOwnership(movement) })) }, retainedArchives: [{ archiveId: archive.archiveId, archive }] };
    const secondCore = accountingCoreFromNative(destinationNative, DESTINATION, "alfred:destination");
    expect(secondCore.datasets.movements).toHaveLength(core.datasets.movements.length);
    const secondArchive = await readArchive(await createArchive({ sourceApp: "alfred", namespace: "alfred:destination", timezone: "Africa/Accra", currency: "GHS", exportedAt: AT, coverage: [], datasets: { ...secondCore.datasets, "alfred.native": destinationNative } }));
    const secondImport = planImport(emptyAccountingState("third-owner"), secondArchive, "resolution-second-hop", AT, "alfred:third");
    expect(secondImport.conflicts).toEqual([]);
    expect(buildAccountingView(hydrateAccountingSources(secondImport.next, secondImport.sources), "GHS").totals).toEqual({ incomeMinor: 0, spentMinor: 7125 });
    expect((secondArchive.datasets["alfred.native"] as AlfredNativeExport).retainedArchives[0].archive.datasets).toMatchObject({ "alfred.native": { tables: { bankPaymentResolutions: [{ reason: "failed" }, { principal_minor: "3000" }], bankMessages: [{}, {}, { fee: "0.25" }] } } });
  });

  it("does not convert absent, foreign or inconsistent fee proof into a portable expense", () => {
    const { state, raw, messages } = evidence();
    const failedFee = raw.find(transaction => transaction.transactionId === uuid(13))!;
    for (const patch of [
      { userId: "different-owner" }, { status: "deleted" as const }, { type: "income" as const },
      { category: "Food" }, { currency: "USD" }, { amount: "0.50" }, { sourceUpdateId: "unrelated-source" },
    ]) {
      const changed = raw.map(transaction => transaction.transactionId === failedFee.transactionId ? { ...transaction, ...patch } : transaction);
      expect(splitConfirmedBankFeesForPortability(state, changed, messages)).toBe(state);
    }
    expect(splitConfirmedBankFeesForPortability(state, raw.filter(transaction => transaction.transactionId !== failedFee.transactionId), messages)).toBe(state);
    expect(splitConfirmedBankFeesForPortability(state, raw, messages.map(message => message.id === uuid(3) ? { ...message, ownerId: "different-owner" } : message))).toBe(state);
    expect(splitConfirmedBankFeesForPortability({ ...state, movements: state.movements.map(movement => movement.sourceId === uuid(3) ? { ...movement, confirmedFeeMinor: 0 } : movement) }, raw, messages).movements).toHaveLength(state.movements.length);
  });
});
