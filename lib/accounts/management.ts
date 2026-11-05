import type { SupabaseSettings } from "@/lib/config";
import { saveConfirmation, type ActionContext, type Delivery } from "@/lib/finance/action-router";
import { actionFingerprint, applyAccountingAction } from "@/lib/finance/accounting/reducer";
import { loadAccountingReadModel, saveAccountingAction } from "@/lib/finance/accounting/persisted-store";
import { accountingActionSchema } from "@/lib/finance/accounting/schema";
import { AccountingError, type AccountingState, type FinancialAccount } from "@/lib/finance/accounting/types";
import {
  accountManagementActionSchema, accountManagementPendingSchema,
  type AccountConfigurationCommand, type AccountManagementAction, type AccountManagementPending,
} from "./management-schema";

export type AccountManagementResult = { state: AccountingState; availability: "ready" | "migration-required" };
export interface AccountManagementStore {
  read(ownerId: string): Promise<AccountManagementResult>;
  save(ownerId: string, command: AccountConfigurationCommand): Promise<AccountManagementResult>;
}
type Context = ActionContext & { accountManagement?: AccountManagementStore | null };
const unavailable = "Account configuration is unavailable right now. The accounting setup must be ready before I can manage accounts.";
const key = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
const cash = (included: boolean) => included ? "included in cash balance" : "excluded from cash balance";
const reply = (text: string): Delivery => ({ kind: "text", text });

function requireOwner(result: AccountManagementResult, ownerId: string): AccountManagementResult {
  if (result.state.ownerId !== ownerId) throw new AccountingError("Financial state belongs to another owner.", "ownership");
  return result;
}
function checkedCommand(command: AccountConfigurationCommand): AccountConfigurationCommand {
  const parsed = accountingActionSchema.safeParse(command);
  if (!parsed.success || (parsed.data.type !== "create_account" && parsed.data.type !== "update_account")) throw new AccountingError("That account change is invalid.");
  return parsed.data;
}
export function createSupabaseAccountManagementStore(settings: SupabaseSettings): AccountManagementStore {
  return {
    async read(ownerId) { return requireOwner(await loadAccountingReadModel(settings, ownerId), ownerId); },
    async save(ownerId, command) { return requireOwner(await saveAccountingAction(settings, ownerId, checkedCommand(command)), ownerId); },
  };
}

/** Fictional/local adapter with the same revision and durable request-id rules as the persisted store. */
export function createMemoryAccountManagementStore(initial: AccountingState, options: { availability?: AccountManagementResult["availability"]; now?: () => string } = {}): AccountManagementStore {
  let state = structuredClone(initial);
  const availability = options.availability ?? "ready";
  const requests = new Map(initial.audit.map(event => [event.requestId, event.actionFingerprint]));
  const read = (ownerId: string): AccountManagementResult => requireOwner({ state: structuredClone(state), availability }, ownerId);
  return {
    async read(ownerId) { return read(ownerId); },
    async save(ownerId, raw) {
      read(ownerId);
      if (availability !== "ready") return read(ownerId);
      const command = checkedCommand(raw);
      const fingerprint = actionFingerprint(command), prior = requests.get(command.requestId);
      if (prior) {
        if (prior !== fingerprint) throw new AccountingError("This request ID was used for a different action.", "conflict");
        return read(ownerId);
      }
      state = applyAccountingAction(state, command, options.now?.() ?? new Date().toISOString());
      requests.set(command.requestId, fingerprint);
      return read(ownerId);
    },
  };
}

function failure(error: unknown): string {
  if (error instanceof AccountingError) {
    if (error.code === "ownership") return "Those accounts aren't available in this session. Nothing was changed.";
    if (error.code === "stale") return "Your account records changed after the review. Please ask again so I can show the latest changes before saving.";
    if (error.code === "conflict") return "That account request conflicts with the latest records. Please review it again before saving.";
    if (error.code === "not_found") return "That account is no longer available. Nothing was changed.";
  }
  return "I couldn't verify that account change. Check Accounts before trying again.";
}

/** Deterministic account configuration; never a bank connection or a fabricated balance. */
export async function handleAccountManagement(raw: AccountManagementAction, ctx: Context): Promise<Delivery> {
  const parsed = accountManagementActionSchema.safeParse(raw);
  if (!parsed.success) return reply("Please provide the account details you want to manage.");
  const action = parsed.data;
  if (!ctx.accountManagement) return reply(unavailable);
  try {
    const ownerId = ctx.profile.profileId;
    const result = requireOwner(await ctx.accountManagement.read(ownerId), ownerId);
    if (result.availability !== "ready") return reply(unavailable);
    const { state } = result;
    if (action.type === "get_accounts") {
      if (state.accounts.length === 0) return reply("You haven't configured any financial accounts yet. Tell me the account name, provider, currency, and whether to include it in your cash balance.");
      const shown = state.accounts.slice(0, 20);
      return reply(["Your financial accounts:", ...shown.map(account => `• ${account.label} · ${account.provider} · ${account.currency} · ${cash(account.includeInCash)} · ID ${account.id}`), ...(state.accounts.length > shown.length ? [`${state.accounts.length - shown.length} more accounts are available in Accounts.`] : [])].join("\n"));
    }
    const commandFields = { expectedRevision: state.revision, requestId: `chat-account:${ctx.createActionId()}` };
    if (action.type === "create_account") {
      const missing = [!action.provider ? "the provider or bank name" : "", !action.currency ? "which three-letter currency to use" : "", action.include_in_cash == null ? "whether to include it in your cash balance" : ""].filter(Boolean);
      if (missing.length) return reply(`For ${action.label}, tell me ${missing.join(" and ")}.`);
      if (state.accounts.some(account => key(account.label) === key(action.label))) return reply(`You already have an account called ${action.label}. Choose a different name, or ask me to update the existing account.`);
      const command: AccountConfigurationCommand = { ...commandFields, type: "create_account", account: { id: ctx.createId(), label: action.label, provider: action.provider!, currency: action.currency!, includeInCash: action.include_in_cash! } };
      return saveConfirmation(ctx, `Create this financial account?\nName: ${command.account.label}\nProvider: ${command.account.provider}\nCurrency: ${command.account.currency}\nCash balance: ${cash(command.account.includeInCash)}.\nThis records the account configuration; it does not connect the bank or record a balance.\n\nConfirm or cancel.`, { type: "create_account", originUpdateId: String(ctx.updateId), command });
    }
    const matches = action.account_id ? state.accounts.filter(account => account.id === action.account_id) : action.name ? state.accounts.filter(account => key(account.label) === key(action.name!)) : [];
    if (!action.account_id && !action.name) return reply("Which financial account should I update? Tell me its exact name or ID.");
    if (matches.length === 0) return reply("I couldn't find that financial account. Ask me to list your accounts, then choose its exact name or ID.");
    if (matches.length > 1) return reply(`More than one account is called ${action.name}. Choose its ID:\n${matches.slice(0, 10).map(account => `• ${account.id} · ${account.provider} · ${account.currency}`).join("\n")}`);
    const account = matches[0];
    if (action.account_id && action.name && key(action.name) !== key(account.label)) return reply("That account ID and name do not match. Please choose the exact account again.");
    if (action.changes.label && state.accounts.some(item => item.id !== account.id && key(item.label) === key(action.changes.label!))) return reply("Another account already uses that name. Choose a distinct account name.");
    const changes: Extract<AccountConfigurationCommand, { type: "update_account" }>["changes"] = {};
    const lines: string[] = [];
    if (action.changes.label != null && action.changes.label !== account.label) { changes.label = action.changes.label; lines.push(`Name: ${account.label} → ${changes.label}`); }
    if (action.changes.provider != null && action.changes.provider !== account.provider) { changes.provider = action.changes.provider; lines.push(`Provider: ${account.provider} → ${changes.provider}`); }
    if (action.changes.include_in_cash != null && action.changes.include_in_cash !== account.includeInCash) { changes.includeInCash = action.changes.include_in_cash; lines.push(`Cash balance: ${cash(account.includeInCash)} → ${cash(changes.includeInCash)}`); }
    if (!lines.length) return reply("That account already has those settings. Nothing was changed.");
    const command: AccountConfigurationCommand = { ...commandFields, type: "update_account", accountId: account.id, changes };
    return saveConfirmation(ctx, [`Update ${account.label} (${account.provider}, ${account.currency})?`, ...lines, "", "Confirm or cancel."].join("\n"), { type: "update_account", originUpdateId: String(ctx.updateId), command });
  } catch (error) { return reply(failure(error)); }
}

function accountMatches(account: FinancialAccount | undefined, command: AccountConfigurationCommand): boolean {
  if (!account) return false;
  const fields = command.type === "create_account" ? command.account : command.changes;
  return Object.entries(fields).every(([field, value]) => account[field as keyof FinancialAccount] === value);
}

/** Use the reviewed revision and request ID unchanged; the existing writer rejects stale confirmations. */
export async function executeAccountManagement(raw: AccountManagementPending, ctx: Context): Promise<{ text: string }> {
  const parsed = accountManagementPendingSchema.safeParse(raw);
  if (!parsed.success) return { text: "That account confirmation is invalid. Nothing was changed." };
  if (!ctx.accountManagement) return { text: unavailable };
  try {
    const ownerId = ctx.profile.profileId;
    const current = requireOwner(await ctx.accountManagement.read(ownerId), ownerId);
    if (current.availability !== "ready") return { text: unavailable };
    const command = checkedCommand(parsed.data.command);
    const saved = requireOwner(await ctx.accountManagement.save(ownerId, command), ownerId);
    if (saved.availability !== "ready") return { text: unavailable };
    const id = command.type === "create_account" ? command.account.id : command.accountId;
    const account = saved.state.accounts.find(item => item.id === id);
    if (!accountMatches(account, command)) return { text: "I couldn't verify those account settings after the save. Check Accounts before trying again." };
    return { text: `Account ${command.type === "create_account" ? "created" : "updated"}: ${account!.label} · ${account!.provider} · ${account!.currency} · ${cash(account!.includeInCash)}.` };
  } catch (error) { return { text: failure(error) }; }
}
