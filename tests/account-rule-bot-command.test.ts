import { describe, expect, it, vi } from "vitest";

import { ACCOUNT_RULE_COMMAND_HELP, ACCOUNT_RULE_CONFIRM_TTL_MS, ACCOUNT_RULE_PENDING_TYPE, handleAccountRuleBotCommand, isAccountRuleCommand, isScopedAccountRuleIntent, parseAccountRuleBotCommand, type AccountRuleBotDeps, type AccountRuleCommandPendingStore } from "@/lib/account-rules/bot-command";
import { reduceAccountRuleCommand } from "@/lib/account-rules/store";
import { AccountRuleError, emptyAccountRuleState } from "@/lib/account-rules/types";
import { stableJson } from "@/lib/finance/accounting/reducer";
import type { FinancialAccount } from "@/lib/finance/accounting/types";
import { latestOpenPending, decidePending } from "@/lib/finance/pending";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { handleProfileTurn, type StudioDeps } from "@/lib/studio/handle";
import { harness as telegramHarness, NOW, profile, runUpdate, settings, textUpdate } from "./helpers";

type Pending = Parameters<AccountRuleCommandPendingStore["put"]>[0];
const OWNER = "42", CHAT = "100", ACCOUNT = "synthetic:wallet:stable";
const ADD = `/rule add ${ACCOUNT} "Fictional Market" "Food"`;
function botFixture() {
  let now = new Date(NOW), serial = 1;
  let state = emptyAccountRuleState(OWNER);
  const ownedAccounts: FinancialAccount[] = [{ id: ACCOUNT, label: "Fictional wallet", provider: "Synthetic", currency: "GHS", includeInCash: true, createdAt: NOW.toISOString() }, { id: "synthetic:bank:stable", label: "Fictional bank", provider: "Synthetic", currency: "GHS", includeInCash: true, createdAt: NOW.toISOString() }];
  const pending = new Map<string, Pending>(), applied = new Map<string, string>();
  let failCompletion = false, failAfterSave = false;
  const find = (owner: string, chat: string, token: string) => { const row = pending.get(token); return row?.ownerId === owner && row.chatId === chat ? row : null; };
  const deps: AccountRuleBotDeps = {
    load: vi.fn(async (owner) => ({ state: structuredClone({ ...state, ownerId: owner }), availability: "ready" as const })),
    accounts: vi.fn(async (owner) => owner === OWNER ? structuredClone(ownedAccounts) : []),
    save: vi.fn(async (owner, command) => {
      const key = `${owner}:${command.requestId}`, fingerprint = stableJson(command);
      if (applied.has(key)) { if (applied.get(key) !== fingerprint) throw new AccountRuleError("Conflicting request", "conflict"); return { state: structuredClone(state), availability: "ready" as const }; }
      state = reduceAccountRuleCommand(state, command, ownedAccounts, now.toISOString()); applied.set(key, fingerprint);
      if (failAfterSave) throw new Error("Response lost after commit");
      return { state: structuredClone(state), availability: "ready" as const };
    }),
    wasApplied: vi.fn(async (owner, command) => applied.get(`${owner}:${command.requestId}`) === stableJson(command)),
    pending: {
      async put(row) { if (pending.has(row.token)) throw new Error("Duplicate token"); pending.set(row.token, structuredClone(row)); },
      async get(owner, chat, token) { const row = find(owner, chat, token); return row ? structuredClone(row) : null; },
      async claim(owner, chat, token, at) { const row = find(owner, chat, token); if (!row || !["pending", "processing"].includes(row.status) || row.expiresAt <= at) return null; row.status = "processing"; return structuredClone(row); },
      async cancel(owner, chat, token) { const row = find(owner, chat, token); if (!row || row.status !== "pending") return false; row.status = "cancelled"; return true; },
      async complete(owner, chat, token) { if (failCompletion) throw new Error("Receipt failure"); const row = find(owner, chat, token); if (row && ["processing", "completed"].includes(row.status)) row.status = "completed"; },
      async expire(owner, chat, token, at) { const row = find(owner, chat, token); if (row && row.expiresAt <= at && ["pending", "processing"].includes(row.status)) row.status = "expired"; },
    },
    now: () => new Date(now), token: () => String(serial++).padStart(16, "0"), id: () => `00000000-0000-4000-8000-${String(serial).padStart(12, "0")}`,
  };
  return { deps, pending, ownedAccounts, applied, state: () => state, latestToken: () => [...pending.keys()].at(-1)!, setNow: (value: Date) => { now = value; }, failCompletion: (value: boolean) => { failCompletion = value; }, failAfterSave: (value: boolean) => { failAfterSave = value; } };
}
const send = (fixture: ReturnType<typeof botFixture>, text: string, owner = OWNER, chat = CHAT) => handleAccountRuleBotCommand(text, owner, chat, fixture.deps);

describe("explicit deterministic account-rule commands", () => {
  it("parses only explicit commands, fixed quoted text and direction; never expands a wildcard", () => {
    expect(isAccountRuleCommand("Remember this merchant")).toBe(false); expect(parseAccountRuleBotCommand("Remember this merchant")).toBeNull();
    expect(parseAccountRuleBotCommand(ADD)).toEqual({ type: "add", accountId: ACCOUNT, merchant: "Fictional Market", category: "Food", direction: "out" });
    expect(parseAccountRuleBotCommand(`${ADD} any`)).toMatchObject({ direction: "any" });
    expect(parseAccountRuleBotCommand(`/rule@FictionalBot add ${ACCOUNT} "Merchant \\"Q\\"" "Food" in`.replace(/\\\\/g, "\\"))).toMatchObject({ direction: "in" });
    for (const text of [`/rule add all "merchant" "Food"`, `/rule add ${ACCOUNT} "*" "Food"`, `/rule add ${ACCOUNT} merchant Food`, `${ADD} inbound`, `${ADD} out extra`, `/rule add ${ACCOUNT} "escaped\\u0000" "Food"`, `/rule confirm short`, `/rule add ${ACCOUNT} "${"m".repeat(2001)}" "Food"`]) expect(() => parseAccountRuleBotCommand(text)).toThrow();
  });
  it("requires account-scoped confirmation before saving, defaults to exact outgoing, and keeps manual overrides higher priority", async () => {
    const h = botFixture(); const review = await send(h, ADD);
    expect(review).toContain("Fictional wallet"); expect(review).toContain(ACCOUNT); expect(review).toContain("outgoing only"); expect(review).toContain("this account and this merchant only"); expect(review).toContain("manual overrides win"); expect(review).toContain("Nothing is saved yet"); expect(h.state().rules).toEqual([]);
    const token = h.latestToken(); expect(h.pending.get(token)?.expiresAt).toBe(new Date(NOW.getTime() + ACCOUNT_RULE_CONFIRM_TTL_MS).toISOString());
    const saved = await send(h, `/rule confirm ${token}`); expect(saved).toContain("Account rule saved");
    expect(h.state().rules).toHaveLength(1); expect(h.state().rules[0]).toMatchObject({ accountId: ACCOUNT, matchMode: "exact", merchantExact: "fictional market", direction: "out", category: "Food", active: true, effectiveFrom: NOW.toISOString() });
  });
  it("requires the same owner and original chat for both confirm and cancel", async () => {
    const h = botFixture(); await send(h, ADD); const token = h.latestToken();
    expect(await send(h, `/rule confirm ${token}`, "77")).toContain("not available"); expect(await send(h, `/rule confirm ${token}`, OWNER, "other-chat")).toContain("not available"); expect(await send(h, `/rule cancel ${token}`, "77")).toContain("not available");
    expect(h.state().rules).toHaveLength(0); expect(h.pending.get(token)?.status).toBe("pending");
  });
  it("never guesses one account from a provider or a foreign stable ID", async () => {
    const h = botFixture(); expect(await send(h, `/rule add Synthetic "merchant" "Food"`)).toContain("exact financial account ID"); expect(await send(h, `/rule add foreign-account "merchant" "Food"`)).toContain("exact financial account ID"); expect(h.pending.size).toBe(0);
  });
  it("expires confirmations after ten minutes and cancellation prevents later execution", async () => {
    const expired = botFixture(); await send(expired, ADD); const token = expired.latestToken(); expired.setNow(new Date(NOW.getTime() + ACCOUNT_RULE_CONFIRM_TTL_MS)); expect(await send(expired, `/rule confirm ${token}`)).toContain("expired"); expect(expired.state().rules).toHaveLength(0);
    const cancelled = botFixture(); await send(cancelled, ADD); const cancelToken = cancelled.latestToken(); expect(await send(cancelled, `/rule cancel ${cancelToken}`)).toContain("cancelled"); expect(await send(cancelled, `/rule confirm ${cancelToken}`)).toContain("closed"); expect(cancelled.state().rules).toHaveLength(0);
  });
  it("fails closed when the rules revision or selected account changed after review", async () => {
    const h = botFixture(); await send(h, ADD); const token = h.latestToken();
    await h.deps.save(OWNER, { type: "upsert_rule", expectedRevision: 0, requestId: "separate-manual-rule", rule: { id: "00000000-0000-4000-8000-000000000099", accountId: ACCOUNT, matchMode: "exact", merchantExact: "different merchant", category: "Other" } });
    expect(await send(h, `/rule confirm ${token}`)).toContain("Account rules changed"); expect(h.state().rules).toHaveLength(1);
    const changed = botFixture(); await send(changed, ADD); const changedToken = changed.latestToken(); changed.ownedAccounts[0].label = "Renamed account"; expect(await send(changed, `/rule confirm ${changedToken}`)).toContain("account changed"); expect(changed.state().rules).toHaveLength(0);
  });
  it("identifies replacement of an existing same-account exact rule before confirmation", async () => {
    const h = botFixture(); await send(h, ADD); await send(h, `/rule confirm ${h.latestToken()}`);
    const review = await send(h, `/rule add ${ACCOUNT} "Fictional Market" "Groceries"`); expect(review).toContain("Existing matching rule"); expect(review).toContain("Food (enabled) will be updated after confirmation"); expect(h.state().rules[0].category).toBe("Food");
    await send(h, `/rule confirm ${h.latestToken()}`); expect(h.state().rules).toHaveLength(1); expect(h.state().rules[0].category).toBe("Groceries");
  });
  it("makes repeated and concurrent confirmations idempotent", async () => {
    const h = botFixture(); await send(h, ADD); const confirm = `/rule confirm ${h.latestToken()}`;
    await Promise.all([send(h, confirm), send(h, confirm)]); expect(h.state().rules).toHaveLength(1); expect(h.state().revision).toBe(1); expect(await send(h, confirm)).toContain("already confirmed"); expect(h.state().revision).toBe(1);
  });
  it("recovers safely when the rule committed but either its response or pending receipt was lost", async () => {
    const h = botFixture(); await send(h, ADD); const token = h.latestToken(); h.failAfterSave(true);
    expect(await send(h, `/rule confirm ${token}`)).toContain("outcome could not be confirmed"); expect(h.state().revision).toBe(1); h.failAfterSave(false);
    expect(await send(h, `/rule confirm ${token}`)).toContain("already confirmed"); expect(h.state().revision).toBe(1);
    const receipt = botFixture(); await send(receipt, ADD); const r = receipt.latestToken(); receipt.failCompletion(true); expect(await send(receipt, `/rule confirm ${r}`)).toContain("change was saved"); receipt.failCompletion(false); receipt.setNow(new Date(NOW.getTime() + ACCOUNT_RULE_CONFIRM_TTL_MS + 1)); expect(await send(receipt, `/rule confirm ${r}`)).toContain("already confirmed"); expect(receipt.state().revision).toBe(1);
  });
  it("does not claim cancellation succeeded after confirmation started", async () => {
    const h = botFixture(); await send(h, ADD); const token = h.latestToken(); await h.deps.pending.claim(OWNER, CHAT, token, NOW.toISOString());
    expect(await send(h, `/rule cancel ${token}`)).toContain("could not be cancelled"); expect(h.pending.get(token)?.status).toBe("processing");
  });
  it("does not claim a rule was unsaved when a later confirmation-state read is unavailable", async () => {
    const h = botFixture(); await send(h, ADD); const token = h.latestToken(); h.deps.pending.get = async () => { throw new Error("Database read failed"); };
    const response = await send(h, `/rule confirm ${token}`); expect(response).toContain("outcome could not be checked"); expect(response).toContain("retry the same"); expect(response).not.toContain("wasn't saved");
  });
  it("supports inspecting and explicitly confirming disable without broadening any scope", async () => {
    const h = botFixture(); expect(await send(h, "/rule accounts")).toContain(ACCOUNT); expect(await send(h, "/rule list")).toContain("No account rules");
    await send(h, ADD); await send(h, `/rule confirm ${h.latestToken()}`); const id = h.state().rules[0].id;
    expect(await send(h, `/rule list ${ACCOUNT}`)).toContain(id); expect(await send(h, `/rule disable ${id}`)).toContain(`Disable rule ${id}?`); expect(h.state().rules[0].active).toBe(true);
    await send(h, `/rule confirm ${h.latestToken()}`); expect(h.state().rules[0].active).toBe(false);
  });
  it("does not expose unsupported storage or generic pending buttons as permission to create a rule", async () => {
    expect(await handleAccountRuleBotCommand("/rule help", OWNER, CHAT, null)).toBe(ACCOUNT_RULE_COMMAND_HELP); expect(await handleAccountRuleBotCommand(ADD, OWNER, CHAT, null)).toContain("No rule was created");
    const h = botFixture(); h.deps.load = async () => ({ state: emptyAccountRuleState(OWNER), availability: "migration-required" }); expect(await send(h, ADD)).toContain("reviewed database migration"); expect(h.pending.size).toBe(0);
    const store = new MemoryFinanceStore(); await store.appendPendingAction({ actionId: "0000000000000001", userId: OWNER, chatId: CHAT, actionType: ACCOUNT_RULE_PENDING_TYPE, payloadJson: "{}", status: "pending", expiresAt: new Date(NOW.getTime() + 600000).toISOString(), createdAt: NOW.toISOString() });
    expect(await latestOpenPending(store, OWNER, NOW)).toBeNull();
    const result = await decidePending({ actionId: "0000000000000001", chatId: CHAT, decision: "confirm" }, { profile: profile(), store, now: NOW } as unknown as Parameters<typeof decidePending>[1]); expect(result.text).toContain("explicit command"); expect((await store.getPendingAction("0000000000000001"))?.status).toBe("pending");
  });
});

describe("account-rule routing before AI", () => {
  it("routes natural scoped rule requests to fixed guidance without saving memory or guessing scope", async () => {
    for (const text of ["Always categorise all future payments on this account as Food", "Create a merchant rule for my wallet", "Remember the category for every merchant on my bank account"]) expect(isScopedAccountRuleIntent(text)).toBe(true);
    for (const text of ["How much did I spend from my bank account?", "Show all categories for my account", "Categorise yesterday's bank payment as Food", "I am paid on the 25th"]) expect(isScopedAccountRuleIntent(text)).toBe(false);
    const h = telegramHarness(); await runUpdate(textUpdate(8990, 42, "Always categorise all future payments on this account as Food"), h.deps); expect(h.interpret.calls).toBe(0); expect(h.telegram.sent[0].text).toContain("Notebook note does not activate"); expect(await h.store.listPendingActions(OWNER)).toEqual([]);
  });
  it("routes Telegram commands without an LLM configured, persists claims and rejects unlinked owners", async () => {
    const rules = botFixture(), h = telegramHarness({ accountRuleCommands: rules.deps, settings: settings({ deepseek: null }) });
    const update = textUpdate(9001, 42, ADD); await runUpdate(update, h.deps); await runUpdate(update, h.deps);
    expect(h.interpret.calls).toBe(0); expect(rules.pending.size).toBe(1); expect(h.telegram.sent[0].text).toContain("Nothing is saved yet"); expect(h.telegram.sent[0].buttons).toBeUndefined(); expect(h.telegram.sent[1].text).toBe(h.telegram.sent[0].text);
    await runUpdate(textUpdate(9002, 42, `/rule confirm ${rules.latestToken()}`), h.deps); expect(rules.state().rules).toHaveLength(1); expect(h.interpret.calls).toBe(0);
    const foreign = telegramHarness({ accountRuleCommands: rules.deps }); await runUpdate(textUpdate(9003, 77, ADD), foreign.deps); expect(foreign.telegram.sent[0].text).toContain("isn't linked"); expect(rules.pending.size).toBe(1);
  });
  it("routes malformed explicit commands to fixed help instead of interpretation", async () => {
    const h = telegramHarness(); await runUpdate(textUpdate(9010, 42, '/rule add all "merchant" "Food"'), h.deps); expect(h.interpret.calls).toBe(0); expect(h.telegram.sent[0].text).toContain("wildcard scopes");
  });
  it("routes web chat through the same deterministic command and scopes tokens to that chat", async () => {
    const rules = botFixture(), h = telegramHarness(); let updates = 10000;
    const deps: StudioDeps = { settings: { ...settings(), supabase: {} as StudioDeps["settings"]["supabase"], deepseek: settings().deepseek! }, store: h.store, interpret: vi.fn(async () => { throw new Error("AI must not be called"); }), now: () => NOW, createId: h.deps.createId, createActionId: h.deps.createActionId, nextUpdateId: () => ++updates, accountRuleCommands: rules.deps };
    const response = await handleProfileTurn(profile(), { text: ADD, clientId: "account-rule-web-01" }, deps); expect(response.text).toContain("Nothing is saved yet"); const token = rules.latestToken();
    expect(await send(rules, `/rule confirm ${token}`)).toContain("not available");
    const saved = await handleProfileTurn(profile(), { text: `/rule confirm ${token}`, clientId: "account-rule-web-02" }, deps); expect(saved.text).toContain("Account rule saved"); expect(rules.state().rules).toHaveLength(1); expect(deps.interpret).not.toHaveBeenCalled();
  });
});
