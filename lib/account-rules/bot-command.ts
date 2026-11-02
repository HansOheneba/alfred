import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

import type { SupabaseSettings } from "@/lib/config";
import type { FinancialAccount } from "@/lib/finance/accounting/types";
import { stableJson } from "@/lib/finance/accounting/reducer";
import { query } from "@/lib/supabase/connection";
import { accountRuleCommandSchema } from "./schema";
import { loadAccountRules, saveAccountRuleCommand } from "./store";
import { AccountRuleError, normalizeRuleText, type AccountRuleCommand, type AccountRuleResult } from "./types";

export const ACCOUNT_RULE_PENDING_TYPE = "account_rule_command";
export const ACCOUNT_RULE_CONFIRM_TTL_MS = 10 * 60 * 1000;
export const ACCOUNT_RULE_COMMAND_HELP = `Account-specific rules use fixed commands, without AI:
/rule accounts
/rule list [account-id]
/rule add <account-id> "exact merchant text" "Category" [out|in|any]
/rule disable <rule-id>
/rule confirm <token>
/rule cancel <token>

Add defaults to outgoing payments on the selected account only. The quoted merchant is an exact normalized match. Review the account and scope, then confirm within 10 minutes. Rules apply from confirmation onward; manual categories still win. Wildcards and every-merchant/all-account rules are not enabled by these commands.`;
type Parsed = { type: "help" } | { type: "accounts" } | { type: "list"; accountId?: string } | { type: "add"; accountId: string; merchant: string; category: string; direction: "out" | "in" | "any" } | { type: "disable"; ruleId: string } | { type: "confirm"; token: string } | { type: "cancel"; token: string };
type Pending = { token: string; ownerId: string; chatId: string; payload: string; status: "pending" | "processing" | "completed" | "cancelled" | "expired"; createdAt: string; expiresAt: string };
export type AccountRuleCommandPendingStore = {
  put: (pending: Pending) => Promise<void>;
  get: (ownerId: string, chatId: string, token: string) => Promise<Pending | null>;
  claim: (ownerId: string, chatId: string, token: string, now: string) => Promise<Pending | null>;
  cancel: (ownerId: string, chatId: string, token: string) => Promise<boolean>;
  complete: (ownerId: string, chatId: string, token: string) => Promise<void>;
  expire: (ownerId: string, chatId: string, token: string, now: string) => Promise<void>;
};
export type AccountRuleBotDeps = {
  load: (ownerId: string) => Promise<AccountRuleResult>;
  accounts: (ownerId: string) => Promise<FinancialAccount[]>;
  save: (ownerId: string, command: AccountRuleCommand) => Promise<AccountRuleResult>;
  wasApplied: (ownerId: string, command: AccountRuleCommand) => Promise<boolean>;
  pending: AccountRuleCommandPendingStore;
  now: () => Date;
  token: () => string;
  id: () => string;
};
const snapshot = (account: FinancialAccount) => ({ id: account.id, label: account.label, provider: account.provider, currency: account.currency });
const draftSchema = z.strictObject({ schema: z.literal(1), account: z.strictObject({ id: z.string().min(1).max(200), label: z.string().max(120), provider: z.string().max(120), currency: z.string().regex(/^[A-Z]{3}$/) }), command: accountRuleCommandSchema, review: z.string().min(1).max(3500) });
export const isAccountRuleCommand = (text: string) => /^\/rule(?:@[\w_]+)?(?:\s|$)/i.test(text.trim());
const transactionAmount = String.raw`(?:(?:GHS|USD|EUR|GBP|GH[₵¢]|[$€£₵])\s*)?\d+(?:,\d{3})*(?:\.\d{1,2})?(?=\s|$|[,;.!])`;
const leadingTransaction = new RegExp(String.raw`^(?:please\s+)?(?:(?:today|yesterday)\s+)?(?:i\s+)?(?:(?:spent|paid|received|earned)\s+|(?:add|record|log)\s+(?:(?:an?\s+)?(?:expense|payment|purchase|income|receipt|earning|salary|transaction)(?:\s+of)?\s+)?)(?:${transactionAmount})`, "i");
/** Detect a request for a scoped future rule, but never infer or create its contents. */
export function isScopedAccountRuleIntent(text: string): boolean {
  if (text.length > 2000) return false;
  // A clear leading spend/income clause follows the normal recording flow, even
  // when its explanation says "always". Account suffixes, merchant digits and
  // effective dates alone must not send a future rule request to interpretation.
  const normalized = text.normalize("NFKC").trim();
  if (leadingTransaction.test(normalized)) return false;
  return /\b(?:account|wallet|card|bank|momo|gcb|absa)\b/i.test(normalized)
    && /\b(?:categorize|categorise|classify|set|create|add|save|remember|make|apply|file|treat)\b/i.test(normalized)
    && /\b(?:category|categories|categorize|categorise|classification|categorisation|categorization|classify|rule|merchant)\b/i.test(normalized)
    && /\b(?:always|every|each|all|future|automatically|rule|remember|from now on)\b/i.test(normalized);
}
export const ACCOUNT_RULE_INTENT_GUIDANCE = `Use an account-specific rule for future categorization. A Notebook note does not activate a category rule, and no rule or memory note was saved from this request.\n\n${ACCOUNT_RULE_COMMAND_HELP}`;

export function parseAccountRuleBotCommand(text: string): Parsed | null {
  if (!isAccountRuleCommand(text)) return null;
  if (text.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new AccountRuleError("The rule command is too long or contains invalid characters.");
  const input = text.trim().replace(/^\/rule(?:@[\w_]+)?/i, "").trim();
  const tokens: { value: string; quoted: boolean }[] = [];
  let offset = 0;
  while (offset < input.length) {
    const match = /\s*("(?:[^"\\]|\\["\\/bfnrt]|\\u[a-fA-F0-9]{4})*"|[^\s"]+)/y; match.lastIndex = offset;
    const found = match.exec(input); if (!found) throw new AccountRuleError("Use double quotes around the exact merchant text and category.");
    const raw = found[1], quoted = raw.startsWith('"');
    tokens.push({ value: quoted ? JSON.parse(raw) as string : raw, quoted }); offset = match.lastIndex;
    if (tokens.length > 6) throw new AccountRuleError("That rule command has extra arguments.");
  }
  const values = tokens.map((token) => token.value), verb = (values[0] ?? "help").toLowerCase();
  if (verb === "help" && values.length <= 1) return { type: "help" };
  if (verb === "accounts" && values.length === 1) return { type: "accounts" };
  if (verb === "list" && values.length <= 2) return { type: "list", ...(values[1] ? { accountId: values[1] } : {}) };
  if ((verb === "confirm" || verb === "cancel") && values.length === 2 && /^[A-Za-z0-9_-]{16}$/.test(values[1])) return { type: verb, token: values[1] };
  if (verb === "disable" && values.length === 2 && z.uuid().safeParse(values[1]).success) return { type: "disable", ruleId: values[1] };
  if (verb === "add" && (values.length === 4 || values.length === 5) && !tokens[1].quoted && tokens[2].quoted && tokens[3].quoted) {
    const accountId = values[1], merchant = values[2], category = values[3], direction = values[4] ?? "out";
    const invalidText = (value: string) => /[\u0000-\u001f\u007f]/.test(value) || Array.from(value).some((char) => { const point = char.codePointAt(0)!; return point >= 0xd800 && point <= 0xdfff; });
    if (!accountId || accountId.length > 200 || ["*", "all"].includes(accountId.toLowerCase()) || !merchant.trim() || merchant.length > 1200 || normalizeRuleText(merchant).length > 2000 || merchant.trim() === "*" || !category.trim() || category.length > 120 || invalidText(merchant) || invalidText(category) || !["in", "out", "any"].includes(direction)) throw new AccountRuleError("Choose one stable account ID, exact merchant text, category and out/in/any direction. Broad wildcard scopes and hidden control characters are not supported by this command.");
    return { type: "add", accountId, merchant, category: category.trim(), direction: direction as "out" | "in" | "any" };
  }
  throw new AccountRuleError("That rule command is incomplete or has an unsupported scope. Use /rule help for the exact syntax.");
}

/** Handles only explicit /rule commands; its callers route here before any LLM or generic memory. */
export async function handleAccountRuleBotCommand(text: string, ownerId: string, chatId: string, deps: AccountRuleBotDeps | null | undefined): Promise<string | null> {
  try { return await executeAccountRuleBotCommand(text, ownerId, chatId, deps); }
  catch {
    // A failed read may follow a committed confirmation whose response was lost.
    // Never turn an uncertain rule operation into the generic "not saved" reply.
    return "The account-rule command outcome could not be checked. If you were confirming a rule, retry the same /rule confirm token safely. Check /rule list before creating another draft.";
  }
}
async function executeAccountRuleBotCommand(text: string, ownerId: string, chatId: string, deps: AccountRuleBotDeps | null | undefined): Promise<string | null> {
  let input: Parsed | null;
  try { input = parseAccountRuleBotCommand(text); } catch (error) { return `${error instanceof Error ? error.message : "Invalid rule command."}\n\n${ACCOUNT_RULE_COMMAND_HELP}`; }
  if (!input) return null;
  if (input.type === "help") return ACCOUNT_RULE_COMMAND_HELP;
  if (!deps) return "Account-specific rules require the reviewed database migration and account-rule storage. No rule was created.";
  if (!ownerId || !chatId) return "An authenticated owner and the original chat are required. No rule was created.";
  const now = deps.now(), at = now.toISOString();
  if (input.type === "confirm" || input.type === "cancel") {
    const pending = await deps.pending.get(ownerId, chatId, input.token);
    if (!pending) return "That rule confirmation is not available to this owner and chat.";
    let draft: z.infer<typeof draftSchema>;
    try {
      draft = draftSchema.parse(JSON.parse(pending.payload));
      if (!(draft.command.type === "upsert_rule" && draft.command.rule.matchMode === "exact" && draft.command.rule.active === true || draft.command.type === "set_rule_active" && draft.command.active === false)) throw new Error("Unsupported draft");
      if (draft.command.requestId !== `rulebot:${input.token}`) throw new Error("Invalid request identity");
    } catch { return "That rule confirmation is invalid. No rule was created. Send /rule add again."; }
    if (pending.status === "completed") return "That account rule command was already confirmed. No second change was made.";
    if (pending.status === "cancelled" || pending.status === "expired") return "That rule confirmation is closed. Send the command again if you still want it.";
    if (input.type === "cancel") return await deps.pending.cancel(ownerId, chatId, input.token) ? "Rule command cancelled. No rule was changed." : "Confirmation has already started. It could not be cancelled; use /rule list to check its outcome.";
    if (Date.parse(pending.expiresAt) <= now.getTime()) {
      if (pending.status === "processing" && await deps.wasApplied(ownerId, draft.command)) {
        await deps.pending.complete(ownerId, chatId, input.token);
        return "That account rule command was already confirmed. No second change was made.";
      }
      await deps.pending.expire(ownerId, chatId, input.token, at);
      return "That rule confirmation expired after 10 minutes. No new change was made. Send the command again.";
    }
    if (await deps.wasApplied(ownerId, draft.command)) {
      await deps.pending.complete(ownerId, chatId, input.token);
      return "That account rule command was already confirmed. No second change was made.";
    }
    const account = (await deps.accounts(ownerId)).find((item) => item.id === draft.account.id);
    if (!account || stableJson(snapshot(account)) !== stableJson(draft.account)) return "The selected account changed or is unavailable. No rule was created. Review a fresh /rule command.";
    if (!await deps.pending.claim(ownerId, chatId, input.token, at)) return "That rule confirmation changed or expired. Check /rule list before trying again.";
    try {
      const result = await deps.save(ownerId, draft.command);
      if (result.availability !== "ready") return "Account-rule storage is not ready. No rule was created. Apply the reviewed migration, then send a fresh command.";
      try { await deps.pending.complete(ownerId, chatId, input.token); }
      catch { return "The account rule change was saved, but its confirmation receipt could not be updated. Retry the same /rule confirm token to check it safely; do not create a new draft."; }
      return draft.command.type === "upsert_rule" ? `Account rule saved for ${draft.account.label} only.\nExact merchant: ${draft.command.rule.merchantExact}\nDirection: ${draft.command.rule.direction}\nCategory: ${draft.command.rule.category}\nFuture matching payments use this rule; manual categories still win.` : "That account rule is now disabled. Existing manual categories were not changed.";
    } catch (error) {
      if (error instanceof AccountRuleError) return `${error.message} No rule was overwritten. Review a fresh command if its scope or revision changed.`;
      return "The rule-change outcome could not be confirmed. Retry the same /rule confirm token; its stable request ID prevents a duplicate change. Check /rule list before creating another draft.";
    }
  }
  const [loaded, accounts] = await Promise.all([deps.load(ownerId), deps.accounts(ownerId)]);
  if (loaded.availability !== "ready") return "Account-specific rules require the reviewed database migration. No rule was created.";
  if (input.type === "accounts") return accounts.length ? `Financial accounts (use the exact ID):\n${accounts.slice(0,8).map((account) => `${account.label} · ${account.currency}\n${account.id}`).join("\n\n")}${accounts.length>8?`\n\nShowing 8 of ${accounts.length} accounts. The complete account list is in Accounts.`:""}` : "No owned financial accounts are available yet. Create one in Accounts first.";
  if (input.type === "list") {
    if (input.accountId && !accounts.some((account) => account.id === input.accountId)) return "Choose an exact financial account ID owned by this profile. Use /rule accounts.";
    const rules = loaded.state.rules.filter((rule) => !input.accountId || rule.accountId === input.accountId);
    const short = (value: string, limit: number) => value.length > limit ? `${value.slice(0,limit)}…` : value;
    return rules.length ? `Account rules:\n${rules.slice(0,5).map((rule) => `${rule.id} · ${rule.active ? "enabled" : "disabled"}\nAccount: ${short(accounts.find((account) => account.id === rule.accountId)?.label ?? rule.accountId,60)} (${rule.accountId})\n${rule.matchMode === "all" ? "Every merchant (explicit scope)" : `Exact merchant: ${short(rule.merchantExact ?? "",80)}`} · ${rule.direction} → ${short(rule.category,50)}`).join("\n\n")}\n\n${rules.length>5?`Showing 5 of ${rules.length} rules. `:""}Full rule text and the complete list are in Settings → Categorization rules.` : "No account rules match this selection.";
  }
  const existingRule = input.type === "disable" ? loaded.state.rules.find((rule) => rule.id === input.ruleId) : undefined;
  if (input.type === "disable" && !existingRule) return "That rule is not owned by this profile or is unavailable.";
  const accountId = input.type === "add" ? input.accountId : existingRule!.accountId;
  const account = accounts.find((item) => item.id === accountId);
  if (!account) return "Choose an exact financial account ID owned by this profile. Provider names do not identify one account. Use /rule accounts.";
  const token = deps.token(); if (!/^[A-Za-z0-9_-]{16}$/.test(token)) throw new Error("A valid rule confirmation token is required.");
  const command: AccountRuleCommand = input.type === "add" ? { type: "upsert_rule", expectedRevision: loaded.state.revision, requestId: `rulebot:${token}`, rule: { id: deps.id(), accountId, matchMode: "exact", merchantExact: input.merchant, category: input.category, direction: input.direction, active: true } } : { type: "set_rule_active", expectedRevision: loaded.state.revision, requestId: `rulebot:${token}`, ruleId: input.ruleId, active: false };
  const previous = input.type === "add" ? loaded.state.rules.find((rule) => rule.accountId === accountId && rule.matchMode === "exact" && rule.merchantExact === normalizeRuleText(input.merchant) && rule.direction === input.direction) : existingRule;
  const review = input.type === "add" ? `Review this account-specific category rule:\nAccount: ${account.label} · ${account.currency}\nAccount ID: ${account.id}\nMatch: exact normalized merchant text "${input.merchant}"\nDirection: ${input.direction === "any" ? "incoming and outgoing (explicitly requested)" : input.direction === "in" ? "incoming only" : "outgoing only"}\nCategory: ${input.category}${previous ? `\nExisting matching rule: ${previous.id} · ${previous.category} (${previous.active ? "enabled" : "disabled"}) will be updated after confirmation.` : ""}\nScope: this account and this merchant only. Future payments from confirmation onward; manual overrides win.` : `Disable rule ${input.ruleId}?\nAccount: ${account.label} (${account.id})\n${existingRule!.matchMode === "all" ? "Every-merchant scope on this account" : `Exact merchant: ${existingRule!.merchantExact}`}\nCategory: ${existingRule!.category}`;
  const payload = draftSchema.parse({ schema: 1, account: snapshot(account), command, review });
  await deps.pending.put({ token, ownerId, chatId, payload: JSON.stringify(payload), status: "pending", createdAt: at, expiresAt: new Date(now.getTime() + ACCOUNT_RULE_CONFIRM_TTL_MS).toISOString() });
  return `${review}\n\nNothing is saved yet. Within 10 minutes send:\n/rule confirm ${token}\nOr /rule cancel ${token}`;
}

/** Owner/chat-scoped claims ensure Cancel cannot race a confirmation already started. */
export function createAccountRuleBotDeps(settings: SupabaseSettings): AccountRuleBotDeps {
  type Row = { action_id: string; owner_id: string; chat_id: string; payload_json: string; status: Pending["status"]; created_at: Date; expires_at: Date };
  const from = (row: Row): Pending => ({ token: row.action_id, ownerId: row.owner_id, chatId: row.chat_id, payload: row.payload_json, status: row.status, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString() });
  const fields = "action_id,owner_id::text,chat_id,payload_json,status,created_at,expires_at";
  const args = (ownerId: string, chatId: string, token: string) => [ownerId, chatId, token, ACCOUNT_RULE_PENDING_TYPE];
  return {
    load: (ownerId) => loadAccountRules(settings, ownerId), save: (ownerId, command) => saveAccountRuleCommand(settings, ownerId, command),
    async accounts(ownerId) { return (await query<{ accounts: FinancialAccount[] }>(settings, "select state->'accounts' as accounts from public.accounting_states where owner_id=$1::uuid", [ownerId]))[0]?.accounts ?? []; },
    async wasApplied(ownerId, command) {
      const rows = await query<{ action_fingerprint: string }>(settings, "select action_fingerprint from public.account_rule_events where owner_id=$1::uuid and request_id=$2", [ownerId, command.requestId]);
      if (!rows[0]) return false;
      if (rows[0].action_fingerprint !== createHash("sha256").update(stableJson(command)).digest("hex")) throw new AccountRuleError("This rule confirmation ID belongs to a different command.", "conflict");
      return true;
    },
    pending: {
      async put(pending) { await query(settings, "insert into public.pending_actions(action_id,user_id,owner_id,chat_id,action_type,payload_json,status,expires_at,created_at) values($1,$2::text,$2::text::uuid,$3,$4,$5,'pending',$6,$7)", [pending.token,pending.ownerId,pending.chatId,ACCOUNT_RULE_PENDING_TYPE,pending.payload,pending.expiresAt,pending.createdAt]); },
      async get(ownerId,chatId,token) { const rows=await query<Row>(settings,`select ${fields} from public.pending_actions where owner_id=$1::uuid and chat_id=$2 and action_id=$3 and action_type=$4`,args(ownerId,chatId,token));return rows[0]?from(rows[0]):null; },
      async claim(ownerId,chatId,token,now) { const values=[...args(ownerId,chatId,token),now];const rows=await query<Row>(settings,`update public.pending_actions set status='processing' where owner_id=$1::uuid and chat_id=$2 and action_id=$3 and action_type=$4 and status in ('pending','processing') and expires_at>$5::timestamptz returning ${fields}`,values);return rows[0]?from(rows[0]):null; },
      async cancel(ownerId,chatId,token) { return (await query(settings,"update public.pending_actions set status='cancelled' where owner_id=$1::uuid and chat_id=$2 and action_id=$3 and action_type=$4 and status='pending' returning action_id",args(ownerId,chatId,token))).length>0; },
      async complete(ownerId,chatId,token) { await query(settings,"update public.pending_actions set status='completed' where owner_id=$1::uuid and chat_id=$2 and action_id=$3 and action_type=$4 and status in ('processing','completed')",args(ownerId,chatId,token)); },
      async expire(ownerId,chatId,token,now) { await query(settings,"update public.pending_actions set status='expired' where owner_id=$1::uuid and chat_id=$2 and action_id=$3 and action_type=$4 and status in ('pending','processing') and expires_at<=$5::timestamptz",[...args(ownerId,chatId,token),now]); },
    },
    now: () => new Date(), token: () => randomBytes(12).toString("base64url"), id: randomUUID,
  };
}
