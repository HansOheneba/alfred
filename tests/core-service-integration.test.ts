import { describe, expect, it, vi } from "vitest";
import { MemoryMessageLog } from "@/lib/accounts/messages";
import { createMemoryAccountManagementStore } from "@/lib/accounts/management";
import { MemoryPreferenceManagementStore } from "@/lib/accounts/preference-management";
import { buildSystemPrompt } from "@/lib/ai/prompts";
import { ALFRED_SUPABASE_HOST, ALFRED_SUPABASE_PROJECT_REF, ALFRED_SUPABASE_USER } from "@/lib/config";
import { emptyAccountingState } from "@/lib/finance/accounting/types";
import { MemoryBillStore } from "@/lib/finance/bills";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { parseModelOutput, type InterpretedAction } from "@/lib/finance/schemas";
import { handleProfileTurn, type StudioDeps } from "@/lib/studio/handle";
import { harness, NOW, profile, runUpdate, textUpdate } from "./helpers";

function fixtures(action: InterpretedAction) {
  let sequence = 0, update = 10000;
  const store = new MemoryFinanceStore(), bills = new MemoryBillStore();
  const accountManagement = createMemoryAccountManagementStore(emptyAccountingState("42"));
  const preferences = new MemoryPreferenceManagementStore();
  preferences.profiles.set("42", { revision: "profile:0", values: { preferredName: "Fictional owner", currency: "GHS", timezone: "Africa/Accra", communicationPreference: "concise", financialGoals: "" } });
  preferences.reminders.set("42", { revision: "reminders:0", timezone: "Africa/Accra", values: { morningEnabled: false, commuteEnabled: false, eveningEnabled: false, morningTime: "08:00", commuteTime: "17:00", eveningTime: "20:00" } });
  preferences.notifications.set("42", { revision: "notifications:0", values: { paymentMentions: false, outgoingMentions: false, paymentPush: false, paymentPreview: false, billReminders: false, weeklyOverview: false } });
  const interpret = vi.fn(async () => action);
  const deps: StudioDeps = {
    settings: { deepseek: { apiKey: "fictional-only", model: "fixture" }, google: null, supabase: { host: ALFRED_SUPABASE_HOST, projectRef: ALFRED_SUPABASE_PROJECT_REF, user: ALFRED_SUPABASE_USER, database: "postgres", password: "fictional-only" }, authorizedUserIds: [42], currency: "GHS", timezone: "Africa/Accra", confirmTransactions: "auto" },
    store, bills, accountManagement, preferences, interpret, now: () => NOW,
    nextUpdateId: () => ++update, messages: new MemoryMessageLog(),
    createId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    createActionId: () => `service-confirm-${++sequence}`,
  };
  return { deps, store, bills, accountManagement, preferences, interpret };
}
const bill = { type: "create_bill", name: "Fictional fibre", next_date: "2026-11-12", amount: "100.00", currency: "GHS", cadence: "monthly" } as const;

describe("shared channel service management", () => {
  it("creates a bill through the website confirmation flow and invalidates its read snapshot", async () => {
    const { deps, bills, interpret } = fixtures(bill);
    const proposal = await handleProfileTurn(profile(), { text: "Track a GHS 100 monthly fibre bill due 2026-11-12" }, deps);
    expect(proposal.actionId).toBeDefined(); expect(proposal.ledgerChanged).toBe(false);
    expect(await bills.strictList("42")).toEqual([]);
    const outcome = await handleProfileTurn(profile(), { decision: "confirm", actionId: proposal.actionId! }, deps);
    expect(outcome.text).toContain("Tracked"); expect(outcome.ledgerChanged).toBe(true);
    expect(await bills.strictList("42")).toMatchObject([{ name: "Fictional fibre", amount: "100.00", ownerId: "42" }]);
    expect(interpret).toHaveBeenCalledTimes(1);
  });

  it("uses the same reviewed account command from Telegram", async () => {
    const { accountManagement } = fixtures({ type: "get_accounts" });
    const h = harness(); h.deps.accountManagement = accountManagement;
    h.deps.interpret = async () => ({ type: "create_account", label: "Fictional wallet", provider: "Cash", currency: "GHS", include_in_cash: false });
    await runUpdate(textUpdate(8100, 42, "Add a GHS cash wallet excluded from cash totals"), h.deps);
    expect((await accountManagement.read("42")).state.accounts).toEqual([]);
    expect(h.telegram.sent.at(-1)?.buttons?.[0]?.callbackData).toMatch(/^c:/);
    await runUpdate(textUpdate(8101, 42, "yes"), h.deps);
    expect((await accountManagement.read("42")).state.accounts).toMatchObject([{ label: "Fictional wallet", includeInCash: false }]);
    expect(h.telegram.sent.at(-1)?.text).toContain("Account created");
  });

  it("updates only reviewed profile preferences and preserves financial records", async () => {
    const { deps, store, preferences } = fixtures({ type: "update_profile_settings", changes: { preferredName: "Sample", currency: "USD" } });
    const proposal = await handleProfileTurn(profile(), { text: "Call me Sample and use USD by default" }, deps);
    expect((await preferences.readProfile("42")).values.currency).toBe("GHS");
    expect(proposal.text).toContain("USD");
    const result = await handleProfileTurn(profile(), { decision: "confirm", actionId: proposal.actionId! }, deps);
    expect(result.ledgerChanged).toBe(true);
    expect((await preferences.readProfile("42")).values).toMatchObject({ preferredName: "Sample", currency: "USD", timezone: "Africa/Accra" });
    expect((await preferences.readReminders("42")).values.morningEnabled).toBe(false);
    expect(await store.listTransactions("42")).toEqual([]);
  });

  it("keeps ambiguous reminder times and unavailable notification delivery out of confirmations", async () => {
    const { deps, store, preferences } = fixtures({ type: "update_reminder_settings", changes: { morningEnabled: true, morningTime: "8" } });
    const ambiguous = await handleProfileTurn(profile(), { text: "Enable morning check-ins at 8" }, deps);
    expect(ambiguous.actionId).toBeUndefined(); expect(ambiguous.text).toMatch(/AM or PM/);
    deps.interpret = async () => ({ type: "update_notification_settings", changes: { paymentPush: true } });
    const unavailable = await handleProfileTurn(profile(), { text: "Enable payment push" }, deps);
    expect(unavailable.actionId).toBeUndefined(); expect(unavailable.ledgerChanged).toBe(false);
    expect((await preferences.readNotifications("42")).values.paymentPush).toBe(false);
    expect(await store.listPendingActions("42")).toEqual([]);
  });

  it("prevents a multi-service request from sharing one unrelated pending action", async () => {
    const { deps, store, bills, preferences } = fixtures({ type: "several", actions: [bill, { type: "update_profile_settings", changes: { preferredName: "Sample" } }] });
    const reply = await handleProfileTurn(profile(), { text: "Track my fibre bill and call me Sample" }, deps);
    expect(reply.text).toContain("one change at a time"); expect(reply.actionId).toBeUndefined();
    expect(await store.listPendingActions("42")).toEqual([]); expect(await bills.strictList("42")).toEqual([]);
    expect((await preferences.readProfile("42")).values.preferredName).toBe("Fictional owner");
  });

  it("also blocks a second confirmation hidden inside a clarifying offer", async () => {
    const { deps, store, bills } = fixtures({ type: "several", actions: [bill, { type: "clarify", question: "Shall I set your Food budget?", offer: [{ type: "set_budget", category: "Food", amount: "500.00", currency: "GHS", period: "2026-11" }] }] });
    const result = await handleProfileTurn(profile(), { text: "Track fibre and set my Food budget" }, deps);
    expect(result.text).toContain("one change at a time");
    expect(result.actionId).toBeUndefined(); expect(await store.listPendingActions("42")).toEqual([]);
    expect(await bills.strictList("42")).toEqual([]); expect(await store.listBudgets("42")).toEqual([]);
  });

  it("does not present two category writes under a single confirmation", async () => {
    const { deps, store } = fixtures({ type: "several", actions: [
      { type: "create_category", name: "Travel gear", transaction_type: "expense" },
      { type: "create_category", name: "Shopping", transaction_type: "expense" },
    ] });
    const result = await handleProfileTurn(profile(), { text: "Create Travel gear and Shopping categories" }, deps);
    expect(result.text).toContain("one change at a time"); expect(result.actionId).toBeUndefined();
    expect(await store.listPendingActions("42")).toEqual([]); expect(await store.listCategories("42")).toEqual([]);
  });

  it("does not turn a captured-payment reply into a service configuration write", async () => {
    const { deps, store, bills } = fixtures(bill);
    const result = await handleProfileTurn(profile(), { text: "Add this bill", replyToPayment: { bankMessageId: "fictional-closed-payment", requiresPurpose: false } }, deps);
    expect(result.actionId).toBeUndefined(); expect(result.text).toContain("Nothing was changed");
    expect(await store.listPendingActions("42")).toEqual([]); expect(await bills.strictList("42")).toEqual([]);
  });

  it("normalizes model bill amounts and teaches only implemented service behavior", () => {
    const parsed = parseModelOutput(JSON.stringify({ type: "update_bill", name: "Fictional fibre", changes: { amount: "1,200", currency: "usd" } }));
    expect(parsed).toMatchObject({ success: true, data: { type: "update_bill", changes: { amount: "1200.00", currency: "USD" } } });
    const prompt = buildSystemPrompt({ today: "2026-11-05", timezone: "Africa/Accra", currency: "GHS", recent: [], services: ["bills", "accounts", "settings"] });
    expect(prompt).toContain("Connected management services: bills, accounts, settings");
    expect(prompt).toContain("does not convert recorded money"); expect(prompt).toContain("do not invent 08:00");
    expect(prompt).toContain("do not cancel a subscription"); expect(prompt).toContain("one change at a time");
  });

  it("rejects category archive actions and keeps renaming separate from that decision", () => {
    for (const type of ["archive_category", "unarchive_category", "restore_category", "deactivate_category"]) {
      expect(parseModelOutput(JSON.stringify({ type, name: "Shopping" })).success).toBe(false);
    }
    const prompt = buildSystemPrompt({ today: "2026-11-05", timezone: "Africa/Accra", currency: "GHS", recent: [] });
    expect(prompt).toContain("Category archiving and unarchiving are deliberately unavailable");
    expect(prompt).toContain("Never offer to archive, hide, deactivate, unarchive or restore a category");
    expect(prompt).toContain("Category renaming is separately unsupported");
  });
});
