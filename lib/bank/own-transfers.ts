import { createHash } from "node:crypto";
import type { SupabaseSettings, UserProfile } from "@/lib/config";
import { bindMovementAccount } from "@/lib/account-rules/matcher";
import { normalizeRuleText, type AccountRuleState } from "@/lib/account-rules/types";
import { validateAccountData } from "@/lib/finance/accounting/accounts";
import { loadAccountingState, type AccountingResult } from "@/lib/finance/accounting/persisted-store";
import { accountingData, stableJson } from "@/lib/finance/accounting/reducer";
import { hydrateAccountingSources } from "@/lib/finance/accounting/sources";
import { AccountingError, type AccountingState, type CashMovement, type FinancialAccount, type TransferLink } from "@/lib/finance/accounting/types";
import { toMinor } from "@/lib/finance/money";
import { query, withBankIngestTransaction } from "@/lib/supabase/connection";
import { DatabaseError } from "@/lib/errors";
import { logInfo } from "@/lib/log";
import { createSupabaseBankStore, listBankTransferWindow, type BankMessage } from "./store";
import { isOwnName, parseBankText, withoutRecipient } from "./parse";

const WINDOW_MS = 600_000;
class PairingDeferred extends Error {
  constructor(readonly reason: "stale" | "ambiguous" | "unavailable") { super("Automatic transfer pairing needs review."); }
}

function fatalPairFailure(error: unknown): boolean {
  if (!(error instanceof DatabaseError)) return false;
  // Unknown driver/connection failures and cancellation/transaction shutdown remain fatal.
  // A successful savepoint rollback is not permission to conceal an uncertain outer transaction.
  return !error.sqlState || /^(?:08|25|57)/.test(error.sqlState);
}

/** Complete bounded evidence must be present in the ordinary accounting source
 * snapshot. A 201st unseen competitor vetoes pairing; it is never ignored. */
function coveredTransferMessages(loaded: AccountingResult): BankMessage[] | null {
  if (!loaded.transferWindow?.complete) return null;
  const recent = new Map((loaded.bankMessages ?? []).map((row) => [row.id, row]));
  for (const message of loaded.transferWindow.messages) {
    const movement = loaded.state.movements.find((row) => row.id === `bank:${message.id}` && row.ownerId === loaded.state.ownerId && row.sourceKind === "bank" && !row.sourceMissing);
    if (!movement || !recent.has(message.id) || stableJson(recent.get(message.id)) !== stableJson(message)) return null;
  }
  return loaded.transferWindow.messages;
}
const key = (value: string) => normalizeRuleText(value).replace(/[^a-z0-9]/g, "");
/** Only established provider names are aliases; arbitrary account labels never establish a source identity. */
export function transferProvider(value: string): string {
  const normalized = key(value);
  if (["momo", "mtn", "mtnmomo", "mtnmobilemoney", "mobilemoney"].includes(normalized)) return "momo";
  if (["hubtel", "hubtelwallet"].includes(normalized)) return "hubtel";
  if (["absa", "absabank"].includes(normalized)) return "absa";
  if (["gcb", "gcbcard", "gcbbank"].includes(normalized)) return "gcb";
  return normalized;
}

type AccountLabel = { id: string; label: string };
export type OwnTransferNotice = {
  state: "paired" | "candidate"; ownerId: string; pairId: string;
  outgoingBankMessageId: string; incomingBankMessageId: string;
  amount: string; currency: string; fromAccount: AccountLabel; toAccount: AccountLabel;
  evidenceFingerprint: string;
};
export type TransferChatContext = {
  ownerId: string; bankMessageId: string; status: "paired" | "candidate" | "ambiguous" | "unavailable" | "none";
  amount: string; currency: string; accounts: Pick<FinancialAccount, "id" | "label" | "provider">[];
  evidenceFingerprint: string;
  transfer?: OwnTransferNotice;
};
export type TransferChatResult = { status: "paired" | "stale" | "ambiguous" | "unavailable"; transfer?: OwnTransferNotice; changed: boolean };
export type TransferConversationDeps = {
  inspect(ownerId: string, bankMessageId: string): Promise<TransferChatContext>;
  confirm(ownerId: string, bankMessageId: string, input: { requestId: string; fromAccountId?: string; toAccountId?: string; expectedPairId?: string; evidenceFingerprint: string }): Promise<TransferChatResult>;
  reject(ownerId: string, bankMessageId: string, input: { requestId: string; expectedPairId: string; evidenceFingerprint: string }): Promise<{ status: "unpaired" | "stale" | "unavailable"; changed: boolean }>;
};

type Bound = { message: BankMessage; movement: CashMovement; account: FinancialAccount };
const sameMoney = (a: BankMessage, b: BankMessage) => a.currency === b.currency && toMinor(a.amount) > 0 && toMinor(a.amount) === toMinor(b.amount);
const withinWindow = (a: BankMessage, b: BankMessage) => Number.isFinite(Date.parse(a.occurredAt)) && Number.isFinite(Date.parse(b.occurredAt)) && Math.abs(Date.parse(a.occurredAt) - Date.parse(b.occurredAt)) <= WINDOW_MS;

function protectedMovement(state: AccountingState, movement: CashMovement, message: BankMessage): boolean {
  return movement.sourceMissing === true || movement.legacyClassification !== null || message.transactionId !== null ||
    !["needs_label", "transfer"].includes(message.status) || !["payment", "transfer_own"].includes(message.kind) ||
    !["review", "confirmed", "transfer"].includes(movement.status) || movement.categoryOrigin === "manual" ||
    movement.sourceStatus !== undefined && movement.status !== movement.sourceStatus ||
    state.settlements.some((row) => row.original.movementId === movement.id || row.returns.some((item) => item.movementId === movement.id));
}

/** Exact saved assignment wins. Otherwise use explicit bindings, or the only configured cash account for a known provider.
 * A suffix-bearing source never falls back to provider-only matching. Multiple accounts always require a chat choice. */
export function resolveTransferAccount(state: AccountingState, message: BankMessage, rules?: AccountRuleState, explicitId?: string): FinancialAccount | null {
  if (message.ownerId !== state.ownerId) return null;
  const movement = state.movements.find((row) => row.id === `bank:${message.id}` && row.ownerId === state.ownerId && row.sourceId === message.id && !row.sourceMissing);
  if (!movement) return null;
  const owned = state.accounts.filter((account) => account.currency === message.currency && account.includeInCash);
  if (explicitId) return (!movement.accountId || movement.accountId === explicitId) ? owned.find((account) => account.id === explicitId) ?? null : null;
  if (movement.accountId) return owned.find((account) => account.id === movement.accountId) ?? null;
  const bound = rules ? bindMovementAccount(movement, state, rules) : null;
  if (bound) return owned.find((account) => account.id === bound) ?? null;
  if (/\b(?:A\/C|Acct|Account)(?:\s*(?:No\.?|Number|ending(?: in)?))?\s*[:.#]?\s*[X*x•.\s-]*\d{3,}\b/i.test(message.raw)) return null;
  const provider = transferProvider(message.source);
  if (!["hubtel", "momo", "absa", "gcb"].includes(provider)) return null;
  const matches = owned.filter((account) => transferProvider(account.provider) === provider);
  return matches.length === 1 ? matches[0] : null;
}

function boundMessage(state: AccountingState, message: BankMessage, rules?: AccountRuleState, explicitId?: string): Bound | null {
  const movement = state.movements.find((row) => row.id === `bank:${message.id}` && row.ownerId === state.ownerId);
  const account = resolveTransferAccount(state, message, rules, explicitId);
  if (!movement || !account || protectedMovement(state, movement, message)) return null;
  if (state.transfers.some((row) => row.outgoing.movementId === movement.id || row.incoming.movementId === movement.id)) return null;
  return { message, movement, account };
}

/** A time/amount coincidence is only a question. Automatic pairing also needs ownership/reference or a known provider bridge. */
export function positiveOwnTransferEvidence(outgoing: BankMessage, incoming: BankMessage, ownNames: string[]): boolean {
  if (outgoing.kind === "transfer_own" || incoming.kind === "transfer_own") return true;
  const namesOwn = (message: BankMessage) => {
    const parsed = parseBankText(message.raw, { now: new Date(message.occurredAt), timeZone: "UTC", sender: message.source, loose: false });
    return isOwnName(`${message.counterparty} ${parsed.map((row) => withoutRecipient(row.reference)).join(" ")}`, ownNames);
  };
  if (namesOwn(outgoing) || namesOwn(incoming)) return true;
  if (outgoing.externalId && outgoing.externalId.length >= 6 && outgoing.externalId === incoming.externalId) return true;
  const references = (message: BankMessage) => new Set([...message.raw.matchAll(/\b(?:reference|ref)\s*[:#]\s*([a-z0-9-]{6,})/gi)].map((match) => match[1].toLowerCase()).filter((value) => /\d/.test(value)));
  const outReferences = references(outgoing), inReferences = references(incoming);
  if ([...outReferences].some((reference) => inReferences.has(reference))) return true;
  // Hubtel wallet cash-out reaches MTN under the payment rail's Credit.Inv name.
  // This narrow bridge still requires two distinct saved owner accounts and a unique exact pair.
  if (outgoing.source === "hubtel" && incoming.source === "momo" && /was withdrawn from your Hubtel wallet/i.test(outgoing.raw) && /^credit[.\s_-]*inv\.?$/i.test(incoming.counterparty.trim())) return true;
  return outgoing.source === "momo" && incoming.source === "hubtel" && /\bhubtel\b/i.test(outgoing.counterparty) && /was deposited into your Hubtel wallet/i.test(incoming.raw);
}

function notice(outgoing: Bound, incoming: Bound, ownerId: string, paired: boolean): OwnTransferNotice {
  return { state: paired ? "paired" : "candidate", ownerId,
    pairId: `own-transfer:${outgoing.message.id}:${incoming.message.id}`,
    outgoingBankMessageId: outgoing.message.id, incomingBankMessageId: incoming.message.id,
    amount: (toMinor(outgoing.message.amount) / 100).toFixed(2), currency: outgoing.message.currency,
    fromAccount: { id: outgoing.account.id, label: outgoing.account.label }, toAccount: { id: incoming.account.id, label: incoming.account.label },
    evidenceFingerprint: createHash("sha256").update(stableJson([outgoing.message.id, outgoing.movement.sourceFingerprint, incoming.message.id, incoming.movement.sourceFingerprint, outgoing.account.id, incoming.account.id])).digest("hex") };
}

function conversationEvidence(state: AccountingState, messages: BankMessage[], target: BankMessage): string {
  const relevant = messages.filter((row) => row.ownerId === state.ownerId && (row.id === target.id || row.direction !== target.direction && sameMoney(row, target) && withinWindow(row, target))).map((message) => {
    const movement = state.movements.find((row) => row.id === `bank:${message.id}`);
    return { id: message.id, fingerprint: movement?.sourceFingerprint ?? null, status: movement?.status ?? null, accountId: movement?.accountId ?? null, categoryOrigin: movement?.categoryOrigin ?? null };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const accounts = state.accounts.filter((row) => row.currency === target.currency).map(({ id, provider, currency, includeInCash }) => ({ id, provider, currency, includeInCash })).sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(stableJson({ target: target.id, relevant, accounts })).digest("hex");
}

/** Read-only exact matching, with uniqueness checked in both directions rather than choosing the nearest amount. */
export function ownTransferCandidates(state: AccountingState, messages: BankMessage[], rules?: AccountRuleState): OwnTransferNotice[] {
  const bound = messages.filter((row) => row.ownerId === state.ownerId).map((row) => boundMessage(state, row, rules)).filter((row): row is Bound => row !== null);
  const possible = bound.filter((row) => row.message.direction === "out").flatMap((outgoing) => bound.filter((row) => row.message.direction === "in" && row.account.id !== outgoing.account.id && sameMoney(outgoing.message, row.message) && withinWindow(outgoing.message, row.message)).map((incoming) => ({ outgoing, incoming })));
  return possible.filter((pair) => possible.filter((row) => row.outgoing.message.id === pair.outgoing.message.id).length === 1 && possible.filter((row) => row.incoming.message.id === pair.incoming.message.id).length === 1).map(({ outgoing, incoming }) => notice(outgoing, incoming, state.ownerId, false));
}

/** A saved link is usable only while both source fingerprints and owned account identities are current. */
export function savedOwnTransferNotices(state: AccountingState, messages: BankMessage[]): Map<string, OwnTransferNotice> {
  const result = new Map<string, OwnTransferNotice>();
  for (const link of state.transfers) {
    const out = state.movements.find((row) => row.id === link.outgoing.movementId), incoming = state.movements.find((row) => row.id === link.incoming.movementId);
    if (!out || !incoming || out.ownerId !== state.ownerId || incoming.ownerId !== state.ownerId || out.sourceKind !== "bank" || incoming.sourceKind !== "bank" || out.sourceMissing || incoming.sourceMissing || out.direction !== "out" || incoming.direction !== "in" || out.status !== "transfer" || incoming.status !== "transfer" || out.sourceFingerprint !== link.outgoing.sourceFingerprint || incoming.sourceFingerprint !== link.incoming.sourceFingerprint || out.amountMinor !== incoming.amountMinor || out.currency !== incoming.currency || !out.accountId || !incoming.accountId || out.accountId === incoming.accountId) continue;
    const outMessage = messages.find((row) => row.id === out.sourceId && row.ownerId === state.ownerId), inMessage = messages.find((row) => row.id === incoming.sourceId && row.ownerId === state.ownerId);
    const from = state.accounts.find((row) => row.id === out.accountId && row.currency === out.currency), to = state.accounts.find((row) => row.id === incoming.accountId && row.currency === incoming.currency);
    if (!outMessage || !inMessage || !from || !to || !sameMoney(outMessage, inMessage) || outMessage.direction !== "out" || inMessage.direction !== "in") continue;
    const item = { ...notice({ message: outMessage, movement: out, account: from }, { message: inMessage, movement: incoming, account: to }, state.ownerId, true), pairId: link.id };
    result.set(outMessage.id, item); result.set(inMessage.id, item);
  }
  return result;
}

export async function loadOwnTransferNotices(settings: SupabaseSettings, ownerId: string, bankIds: string[]): Promise<Map<string, OwnTransferNotice>> {
  if (!bankIds.length) return new Map();
  const accounting = await loadAccountingState(settings, ownerId, undefined, bankIds);
  if (accounting.availability !== "ready") return new Map();
  const messages = coveredTransferMessages(accounting);
  if (!messages) return new Map();
  const result = savedOwnTransferNotices(accounting.state, messages);
  for (const candidate of ownTransferCandidates(accounting.state, messages)) for (const id of [candidate.outgoingBankMessageId, candidate.incomingBankMessageId]) if (!result.has(id)) result.set(id, candidate);
  const wanted = new Set(bankIds);
  return new Map([...result].filter(([id]) => wanted.has(id)));
}
export async function loadOwnTransferNotice(settings: SupabaseSettings, ownerId: string, bankId: string): Promise<OwnTransferNotice | null> {
  return (await loadOwnTransferNotices(settings, ownerId, [bankId])).get(bankId) ?? null;
}

/** Construct one auditable metadata-only revision after the raw bank classification was committed in this transaction. */
export function pairOwnTransferState(state: AccountingState, pair: OwnTransferNotice, requestId: string, at: string, automatic?: TransferLink["automatic"]): AccountingState {
  if (pair.ownerId !== state.ownerId || pair.fromAccount.id === pair.toAccount.id) throw new Error("Transfer ownership changed.");
  const out = state.movements.find((row) => row.id === `bank:${pair.outgoingBankMessageId}`), incoming = state.movements.find((row) => row.id === `bank:${pair.incomingBankMessageId}`);
  if (!out || !incoming || out.ownerId !== state.ownerId || incoming.ownerId !== state.ownerId || out.sourceMissing || incoming.sourceMissing || out.direction !== "out" || incoming.direction !== "in" || out.currency !== incoming.currency || out.currency !== pair.currency || out.amountMinor !== incoming.amountMinor || out.amountMinor !== toMinor(pair.amount)) throw new Error("Transfer evidence changed.");
  if (state.transfers.some((row) => [out.id, incoming.id].includes(row.outgoing.movementId) || [out.id, incoming.id].includes(row.incoming.movementId))) throw new Error("Transfer source is already linked.");
  const movements = state.movements.map((row) => row.id === out.id ? { ...row, accountId: pair.fromAccount.id, status: "transfer" as const } : row.id === incoming.id ? { ...row, accountId: pair.toAccount.id, status: "transfer" as const } : row);
  const hydrated = hydrateAccountingSources({ ...state, movements }, movements);
  const fingerprint = stableJson({ type: "automatic_pair_transfer", pairId: pair.pairId, outgoing: { id: out.id, fingerprint: out.sourceFingerprint }, incoming: { id: incoming.id, fingerprint: incoming.sourceFingerprint }, from: pair.fromAccount.id, to: pair.toAccount.id });
  const revision = state.revision + 1;
  const next: AccountingState = { ...hydrated, revision, transfers: [...state.transfers, { id: pair.pairId, outgoing: { movementId: out.id, sourceFingerprint: out.sourceFingerprint }, incoming: { movementId: incoming.id, sourceFingerprint: incoming.sourceFingerprint }, createdAt: at, ...(automatic ? { automatic } : {}) }], audit: [...state.audit, { id: `revision:${revision}`, requestId, action: "automatic_pair_transfer", actionFingerprint: fingerprint, at, revision, before: accountingData(state) }].slice(-50) };
  validateAccountData(next); return next;
}

async function persistPair(settings: SupabaseSettings, ownerId: string, pair: OwnTransferNotice, requestId: string, now = new Date()): Promise<OwnTransferNotice> {
  const bank = createSupabaseBankStore(settings);
  await query(settings, "select id from public.bank_messages where owner_id=$1::uuid and id=any($2::uuid[]) order by id for update", [ownerId, [pair.outgoingBankMessageId, pair.incomingBankMessageId]]);
  await query(settings, "select owner_id from public.accounting_states where owner_id=$1::uuid for update", [ownerId]);
  const pivots = [pair.outgoingBankMessageId, pair.incomingBankMessageId];
  const before = await loadAccountingState(settings, ownerId, undefined, pivots);
  const messages = coveredTransferMessages(before);
  if (!messages) throw new PairingDeferred("unavailable");
  const outgoing = messages.find((row) => row.id === pair.outgoingBankMessageId), incoming = messages.find((row) => row.id === pair.incomingBankMessageId);
  if (before.availability !== "ready" || !outgoing || !incoming || !sameMoney(outgoing, incoming) || !withinWindow(outgoing, incoming) || !boundMessage(before.state, outgoing, undefined, pair.fromAccount.id) || !boundMessage(before.state, incoming, undefined, pair.toAccount.id)) throw new PairingDeferred("stale");
  const selected = { ...before.state, movements: before.state.movements.map((row) => row.id === `bank:${outgoing.id}` ? { ...row, accountId: pair.fromAccount.id } : row.id === `bank:${incoming.id}` ? { ...row, accountId: pair.toAccount.id } : row) };
  const stillUnique = ownTransferCandidates(selected, messages).filter((row) => row.outgoingBankMessageId === outgoing.id || row.incomingBankMessageId === incoming.id);
  if (stillUnique.length !== 1 || stillUnique[0].pairId !== pair.pairId) throw new PairingDeferred("ambiguous");
  const automatic: TransferLink["automatic"] = { version: 1, pairedRevision: before.state.revision + 1,
    outgoing: { movementStatus: before.state.movements.find((row) => row.id === `bank:${outgoing.id}`)!.status, bankStatus: outgoing.status as "needs_label" | "transfer", bankKind: outgoing.kind as "payment" | "transfer_own" },
    incoming: { movementStatus: before.state.movements.find((row) => row.id === `bank:${incoming.id}`)!.status, bankStatus: incoming.status as "needs_label" | "transfer", bankKind: incoming.kind as "payment" | "transfer_own" } };
  for (const id of [pair.outgoingBankMessageId, pair.incomingBankMessageId]) await bank.updateMessage(ownerId, id, { kind: "transfer_own", status: "transfer" });
  const fresh = await loadAccountingState(settings, ownerId, undefined, pivots);
  if (fresh.availability !== "ready") throw new PairingDeferred("unavailable");
  const finalMessages = coveredTransferMessages(fresh);
  if (!finalMessages) throw new PairingDeferred("unavailable");
  const finalSelected = { ...fresh.state, movements: fresh.state.movements.map((row) => row.id === `bank:${outgoing.id}` ? { ...row, accountId: pair.fromAccount.id } : row.id === `bank:${incoming.id}` ? { ...row, accountId: pair.toAccount.id } : row) };
  const finalCandidates = ownTransferCandidates(finalSelected, finalMessages).filter((row) => row.outgoingBankMessageId === outgoing.id || row.incomingBankMessageId === incoming.id);
  if (finalCandidates.length !== 1 || finalCandidates[0].pairId !== pair.pairId) throw new PairingDeferred("ambiguous");
  const next = pairOwnTransferState(fresh.state, pair, requestId, now.toISOString(), automatic);
  const fingerprint = next.audit.at(-1)!.actionFingerprint;
  const rows = await query<{ result: { status: string; state?: AccountingState } }>(settings, "select public.alfred_write_accounting_state($1::uuid,$2::bigint,$3,$4,$5,$6::jsonb) as result", [ownerId, fresh.state.revision, requestId, fingerprint, fresh.sourceVersion, JSON.stringify(next)]);
  if (["stale", "source_changed", "conflict"].includes(rows[0]?.result.status)) throw new PairingDeferred("stale");
  if (!["saved", "duplicate"].includes(rows[0]?.result.status)) throw new Error("The transfer store did not confirm its metadata write.");
  const confirmedMessages = [ { ...outgoing, status: "transfer" as const, kind: "transfer_own" as const }, { ...incoming, status: "transfer" as const, kind: "transfer_own" as const } ];
  return savedOwnTransferNotices(next, confirmedMessages).get(pair.outgoingBankMessageId)!;
}

/** Called only inside the existing owner-serialized ingest transaction, after all new evidence is stored. */
export async function reconcileNewOwnTransfers(settings: SupabaseSettings, profile: UserProfile, newBankIds: string[]): Promise<Set<string>> {
  const pairedIds = new Set<string>();
  if (!newBankIds.length) return pairedIds;
  const bank = createSupabaseBankStore(settings);
  const gate = await listBankTransferWindow(settings, profile.profileId, newBankIds);
  if (!gate.complete) return pairedIds;
  const nearby = gate.messages;
  const relevant = nearby.filter((row) => newBankIds.includes(row.id));
  if (!relevant.some((row) => nearby.some((other) => other.id !== row.id && other.direction !== row.direction && sameMoney(row, other) && withinWindow(row, other)))) return pairedIds;
  let loaded: AccountingResult; let names: string[];
  try { [loaded, names] = await Promise.all([loadAccountingState(settings, profile.profileId, undefined, newBankIds), bank.accountNames(profile.profileId)]); }
  catch (error) {
    // A source-version mismatch is a read-only optimistic conflict, not a failed
    // SQL statement. No pairing write has run, so the valid new SMS can commit.
    if (!(error instanceof AccountingError) || error.code !== "stale") throw error;
    logInfo("own_transfer_pair_deferred", { reason: "stale" }); return pairedIds;
  }
  if (loaded.availability !== "ready" || !loaded.state.accounts.length) return pairedIds;
  const messages = coveredTransferMessages(loaded);
  if (!messages) return pairedIds;
  const candidates = ownTransferCandidates(loaded.state, messages).filter((pair) => newBankIds.includes(pair.outgoingBankMessageId) || newBankIds.includes(pair.incomingBankMessageId));
  for (const pair of candidates) {
    if (loaded.state.transferRejections?.some((rejected) => rejected === pair.pairId || rejected.split(":").slice(1).some((id) => id === pair.outgoingBankMessageId || id === pair.incomingBankMessageId))) continue;
    const outgoing = messages.find((row) => row.id === pair.outgoingBankMessageId)!, incoming = messages.find((row) => row.id === pair.incomingBankMessageId)!;
    if (outgoing.readBy !== "rules" || incoming.readBy !== "rules" || !positiveOwnTransferEvidence(outgoing, incoming, names)) continue;
    const requestId = `own_transfer_${createHash("sha256").update(pair.pairId).digest("hex")}`;
    await query(settings, "savepoint alfred_automatic_transfer_pair");
    try {
      await persistPair(settings, profile.profileId, pair, requestId);
      await query(settings, "release savepoint alfred_automatic_transfer_pair");
      pairedIds.add(pair.outgoingBankMessageId); pairedIds.add(pair.incomingBankMessageId);
    } catch (error) {
      // Roll back EVERY pairing effect, including bank classification, snapshots,
      // accounting state and its event, without discarding the newly ingested SMS.
      // Any rollback/release failure escapes and aborts the outer transaction.
      await query(settings, "rollback to savepoint alfred_automatic_transfer_pair");
      await query(settings, "release savepoint alfred_automatic_transfer_pair");
      if (fatalPairFailure(error)) throw error;
      logInfo("own_transfer_pair_deferred", { reason: error instanceof PairingDeferred ? error.reason : "pair_write_failed" });
    }
  }
  return pairedIds;
}

export function createTransferConversationDeps(settings: SupabaseSettings): TransferConversationDeps {
  return {
    async inspect(ownerId, bankMessageId) {
      const bank = createSupabaseBankStore(settings), target = await bank.getMessage(ownerId, bankMessageId);
      const base: TransferChatContext = { ownerId, bankMessageId, status: "none", amount: target?.amount ?? "0.00", currency: target?.currency ?? "GHS", accounts: [], evidenceFingerprint: "" };
      if (!target) return base;
      const loaded = await loadAccountingState(settings, ownerId, undefined, [bankMessageId]);
      if (loaded.availability !== "ready") return { ...base, status: "unavailable" };
      const messages = coveredTransferMessages(loaded);
      if (!messages) return { ...base, status: "unavailable" };
      base.evidenceFingerprint = conversationEvidence(loaded.state, messages, target);
      base.accounts = loaded.state.accounts.filter((row) => row.currency === target.currency && row.includeInCash).map(({ id, label, provider }) => ({ id, label, provider }));
      const saved = savedOwnTransferNotices(loaded.state, messages).get(bankMessageId);
      if (saved) return { ...base, status: "paired", transfer: saved };
      const candidate = ownTransferCandidates(loaded.state, messages).find((row) => row.outgoingBankMessageId === bankMessageId || row.incomingBankMessageId === bankMessageId);
      if (candidate) return { ...base, status: "candidate", transfer: candidate };
      const peers = messages.filter((row) => row.id !== target.id && row.ownerId === ownerId && row.direction !== target.direction && sameMoney(row, target) && withinWindow(row, target));
      return { ...base, status: peers.length ? "ambiguous" : "none" };
    },
    async confirm(ownerId, bankMessageId, input) {
      if (!/^[\w:.-]{1,160}$/.test(input.requestId)) return { status: "stale", changed: false };
      return withBankIngestTransaction(settings, ownerId, async () => {
        const bank = createSupabaseBankStore(settings), target = await bank.getMessage(ownerId, bankMessageId);
        if (!target) return { status: "stale", changed: false };
        await query(settings, "select id from public.bank_messages where owner_id=$1::uuid and occurred_at between $2::timestamptz and $3::timestamptz order by id for update", [ownerId, new Date(Date.parse(target.occurredAt) - WINDOW_MS).toISOString(), new Date(Date.parse(target.occurredAt) + WINDOW_MS).toISOString()]);
        const loaded = await loadAccountingState(settings, ownerId, undefined, [bankMessageId]);
        if (loaded.availability !== "ready") return { status: "unavailable", changed: false };
        const messages = coveredTransferMessages(loaded);
        if (!messages) return { status: "unavailable", changed: false };
        const saved = savedOwnTransferNotices(loaded.state, messages).get(bankMessageId);
        if (saved) return { status: "paired", transfer: saved, changed: false };
        if (!input.evidenceFingerprint || input.evidenceFingerprint !== conversationEvidence(loaded.state, messages, target)) return { status: "stale", changed: false };
        // Explicit account choices only bind these two observed source legs, never all provider activity.
        const explicit = { ...loaded.state, movements: loaded.state.movements.map((row) => {
          const message = messages.find((item) => item.id === row.sourceId && item.ownerId === ownerId);
          if (!message || !sameMoney(message, target) || !withinWindow(message, target)) return row;
          const accountId = message.direction === "out" ? input.fromAccountId : input.toAccountId;
          return accountId && resolveTransferAccount(loaded.state, message, undefined, accountId) ? { ...row, accountId } : row;
        }) };
        const pairs = ownTransferCandidates(explicit, messages).filter((row) => row.outgoingBankMessageId === bankMessageId || row.incomingBankMessageId === bankMessageId);
        if (pairs.length !== 1) return { status: "ambiguous", changed: false };
        if (input.fromAccountId && input.fromAccountId !== pairs[0].fromAccount.id || input.toAccountId && input.toAccountId !== pairs[0].toAccount.id) return { status: "stale", changed: false };
        if (input.expectedPairId && input.expectedPairId !== pairs[0].pairId) return { status: "stale", changed: false };
        const paired = await persistPair(settings, ownerId, pairs[0], `chat_transfer_${createHash("sha256").update(input.requestId).digest("hex")}`);
        return { status: "paired", transfer: paired, changed: true };
      });
    },
    async reject(ownerId, bankMessageId, input) {
      if (!/^[\w:.-]{1,160}$/.test(input.requestId) || !input.expectedPairId || !input.evidenceFingerprint) return { status: "stale", changed: false };
      return withBankIngestTransaction(settings, ownerId, async () => {
        await query(settings, "select owner_id from public.accounting_states where owner_id=$1::uuid for update", [ownerId]);
        const bank = createSupabaseBankStore(settings), initial = await bank.getMessage(ownerId, bankMessageId);
        if (!initial) return { status: "stale", changed: false };
        await query(settings, "select id from public.bank_messages where owner_id=$1::uuid and occurred_at between $2::timestamptz and $3::timestamptz order by id for update", [ownerId, new Date(Date.parse(initial.occurredAt) - WINDOW_MS).toISOString(), new Date(Date.parse(initial.occurredAt) + WINDOW_MS).toISOString()]);
        const loaded = await loadAccountingState(settings, ownerId, undefined, [bankMessageId]);
        if (loaded.availability !== "ready") return { status: "unavailable", changed: false };
        const messages = coveredTransferMessages(loaded);
        if (!messages) return { status: "unavailable", changed: false };
        const pair = savedOwnTransferNotices(loaded.state, messages).get(bankMessageId);
        if (!pair || pair.pairId !== input.expectedPairId || input.evidenceFingerprint !== conversationEvidence(loaded.state, messages, initial)) return { status: "stale", changed: false };
        const link = loaded.state.transfers.find((row) => row.id === pair.pairId);
        if (!link?.automatic) return { status: "unavailable", changed: false };
        const movementIds = [link.outgoing.movementId, link.incoming.movementId];
        const later = await query<{ action: string; action_fingerprint: string }>(settings, "select action,action_fingerprint from public.accounting_events where owner_id=$1::uuid and revision>$2::bigint order by revision", [ownerId, link.automatic.pairedRevision]);
        for (const event of later) {
          // Never remove a later user edit or cross an import/undo boundary. Unrelated account edits stay intact.
          if (["undo", "import", "undo_import"].includes(event.action) || movementIds.some((id) => event.action_fingerprint.includes(JSON.stringify(id)))) return { status: "stale", changed: false };
        }
        // The user's explicit correction outranks an earlier automatic own-name heuristic as well as this pair.
        await bank.updateMessage(ownerId, pair.outgoingBankMessageId, { status: "needs_label", kind: "payment" });
        await bank.updateMessage(ownerId, pair.incomingBankMessageId, { status: "needs_label", kind: "payment" });
        const fresh = await loadAccountingState(settings, ownerId);
        if (fresh.availability !== "ready") throw new Error("Account storage became unavailable.");
        const requestId = `chat_transfer_reject_${createHash("sha256").update(input.requestId).digest("hex")}`;
        const fingerprint = stableJson({ type: "reject_automatic_transfer", pairId: pair.pairId, evidenceFingerprint: input.evidenceFingerprint });
        const revision = fresh.state.revision + 1, at = new Date().toISOString();
        const next: AccountingState = { ...fresh.state, revision, transfers: fresh.state.transfers.filter((row) => row.id !== pair.pairId),
          transferRejections: [...new Set([...(fresh.state.transferRejections ?? []), pair.pairId])],
          movements: fresh.state.movements.map((row) => movementIds.includes(row.id) ? { ...row, status: "review", automaticTransferStale: false } : row),
          // The logical before-image is the validated paired state, not the
          // intermediate source-reset projection. Both reads share its locked revision.
          audit: [...fresh.state.audit, { id: `revision:${revision}`, requestId, action: "reject_automatic_transfer", actionFingerprint: fingerprint, at, revision, before: accountingData(loaded.state) }].slice(-50) };
        validateAccountData(next);
        const rows = await query<{ result: { status: string } }>(settings, "select public.alfred_write_accounting_state($1::uuid,$2::bigint,$3,$4,$5,$6::jsonb) as result", [ownerId, fresh.state.revision, requestId, fingerprint, fresh.sourceVersion, JSON.stringify(next)]);
        if (!["saved", "duplicate"].includes(rows[0]?.result.status)) throw new Error("Transfer changed before the correction was saved.");
        return { status: "unpaired", changed: true };
      });
    },
  };
}
