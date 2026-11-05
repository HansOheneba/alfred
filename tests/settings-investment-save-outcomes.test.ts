import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, Field } from "@/app/components/ui";
import { SettingsView } from "@/app/settings/settings-view";
import { InvestmentsClient } from "@/app/investments/investments-client";
import type { AccountSettings } from "@/lib/accounts/settings-store";
import { includedAccountCash } from "@/lib/finance/accounting/cash-summary";
import { valuePortfolio } from "@/lib/investments/value";

type Element = ReactElement<Record<string, unknown>>;
type Setter<T> = (next: T | ((old: T) => T)) => void;
const runtime = vi.hoisted(() => ({ current: null as { state<T>(initial: T | (() => T)): [T, Setter<T>] } | null }));
const mutations = vi.hoisted(() => ({ request: vi.fn(), recover: vi.fn(), refresh: vi.fn() }));
vi.mock("@/app/components/mutation-request", () => ({ requestMutationJson: mutations.request, requireMutationRecovery: mutations.recover, MutationUnconfirmedError: class extends Error { constructor() { super("The result could not be confirmed. Reload latest records before making another change."); } } }));
vi.mock("@/app/settings/lazy-settings-data", () => ({ useOwnedSettingsData: () => ({ value: undefined, refreshing: false, retry: mutations.refresh }) }));
vi.mock("react", async load => {
  const react = await load<typeof import("react")>();
  return { ...react, useState: <T>(initial: T | (() => T)) => runtime.current ? runtime.current.state(initial) : react.useState(initial), useEffect: () => undefined };
});

function nodes(value: ReactNode): Element[] { return Array.isArray(value) ? value.flatMap(nodes) : isValidElement<Record<string, unknown>>(value) ? [value, ...nodes(value.props.children as ReactNode)] : []; }
function text(value: ReactNode): string { return typeof value === "string" || typeof value === "number" ? String(value) : Array.isArray(value) ? value.map(text).join("") : isValidElement<Record<string, unknown>>(value) ? text(value.props.children as ReactNode) : ""; }
class Screen {
  private values: unknown[] = []; private cursor = 0; tree!: ReactNode;
  constructor(private component: () => ReactNode) {}
  state<T>(initial: T | (() => T)): [T, Setter<T>] { const index = this.cursor++; if (!(index in this.values)) this.values[index] = typeof initial === "function" ? (initial as () => T)() : initial; return [this.values[index] as T, next => { this.values[index] = typeof next === "function" ? (next as (old: T) => T)(this.values[index] as T) : next; }]; }
  render() { this.cursor = 0; runtime.current = this; try { this.tree = this.component(); } finally { runtime.current = null; } return this; }
  field(label: string) { return nodes(nodes(this.tree).find(node => node.type === Field && node.props.label === label)!.props.children as ReactNode).find(node => node.type === "input")!; }
  change(label: string, value: string) { (this.field(label).props.onChange as (event: unknown) => void)({ target: { value } }); return this.render(); }
  button(label: string) { return nodes(this.tree).find(node => node.type === Button && text(node.props.children as ReactNode).trim() === label)!; }
  async submitForm() { await (nodes(this.tree).find(node => node.type === "form")!.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault: vi.fn() }); return this.render(); }
  get saveBar() { return nodes(this.tree).find(node => typeof node.type === "function" && node.type.name === "SaveBar")!; }
  async saveSettings() { (this.saveBar.props.onSave as () => void)(); await Promise.resolve(); await Promise.resolve(); return this.render(); }
}
const initial: AccountSettings = { preferredName: "Sample", currency: "GHS", timezone: "Africa/Accra", communicationPreference: "concise", financialGoals: "", telegramUserId: "", telegramLocked: false, morningEnabled: false, commuteEnabled: false, eveningEnabled: false, morningTime: "08:00", commuteTime: "09:00", eveningTime: "19:00" };
const portfolio = valuePortfolio({ investments: [{ id: "sample-fund", ownerId: "sample-owner", name: "Sample fund", kind: "mutual_fund", provider: "Sample", currency: "GHS", investedBefore: "100.00", principal: null, rate: null, startedOn: null, maturesOn: null, remindedAt: null, payeeKey: null, status: "active" }], holdings: [], values: [], contributions: [], prices: [], today: "2026-11-05" });
function investmentComponent(name: "AddInvestment" | "InvestmentCard") {
  const root = new Screen(() => InvestmentsClient({ initial: { portfolio, cash: includedAccountCash(null, "GHS"), contributions: [] } })).render();
  const component = nodes(root.tree).find(node => typeof node.type === "function" && node.type.name === name)!;
  const changed = vi.fn(), closed = vi.fn();
  return { screen: new Screen(() => (component.type as (props: Record<string, unknown>) => ReactNode)({ ...component.props, open: true, onSaved: changed, onChange: changed, onClose: closed })).render(), changed, closed };
}
afterEach(() => { runtime.current = null; vi.clearAllMocks(); });

describe("Settings mutation outcomes", () => {
  it("keeps the edited draft and exits Saving when the shared request cannot confirm a write", async () => {
    const message = "This save could not be confirmed. Reload latest records.";
    mutations.request.mockRejectedValueOnce(new Error(message));
    const screen = new Screen(() => SettingsView({ initial, home: "chat" })).render().change("Preferred name", "Edited");
    await screen.saveSettings();
    expect(screen.saveBar.props.state).toEqual({ kind: "error", text: message }); expect(screen.saveBar.props.dirty).toBe(true);
    expect(screen.field("Preferred name").props.value).toBe("Edited"); expect(mutations.refresh).not.toHaveBeenCalled();
    expect(mutations.request).toHaveBeenCalledWith("/api/settings", "POST", { ...initial, preferredName: "Edited" });
  });
  it.each([null, { ok: true }, { ok: true, settings: { preferredName: "Incomplete" } }])("does not mark malformed success as saved: %j", async payload => {
    mutations.request.mockResolvedValueOnce(payload);
    const screen = new Screen(() => SettingsView({ initial, home: "chat" })).render().change("Preferred name", "Edited"); await screen.saveSettings();
    expect(screen.saveBar.props.state).toMatchObject({ kind: "error" }); expect(screen.saveBar.props.dirty).toBe(true);
    expect(mutations.recover).toHaveBeenCalledOnce(); expect(mutations.refresh).not.toHaveBeenCalled();
  });
  it("publishes only complete confirmed settings and preserves application rejection", async () => {
    const screen = new Screen(() => SettingsView({ initial, home: "chat" })).render().change("Preferred name", "Edited");
    mutations.request.mockResolvedValueOnce({ ok: false, text: "Check the name." }); await screen.saveSettings();
    expect(screen.saveBar.props.state).toEqual({ kind: "error", text: "Check the name." }); expect(screen.saveBar.props.dirty).toBe(true); expect(mutations.recover).not.toHaveBeenCalled();
    mutations.request.mockResolvedValueOnce({ ok: true, settings: { ...initial, preferredName: "Confirmed" } }); await screen.saveSettings();
    expect(screen.saveBar.props.state).toEqual({ kind: "saved" }); expect(screen.saveBar.props.dirty).toBe(false); expect(screen.field("Preferred name").props.value).toBe("Confirmed"); expect(mutations.refresh).toHaveBeenCalledOnce();
  });
});

describe("Investment mutation outcomes", () => {
  it("keeps an unconfirmed addition open, clears busy and preserves reload wording", async () => {
    mutations.request.mockRejectedValueOnce(new Error("Result unconfirmed. Reload latest records."));
    const { screen, changed, closed } = investmentComponent("AddInvestment"); screen.change("Name", "Sample new fund"); await screen.submitForm();
    expect(screen.button("Add").props.disabled).toBe(false); expect(text(screen.tree)).toContain("Result unconfirmed. Reload latest records."); expect(changed).not.toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled();
    expect(mutations.request).toHaveBeenCalledWith("/api/investments", "POST", { op: "add", name: "Sample new fund", kind: "us_stocks", currency: "USD", value: null, principal: null, rate: null, maturesOn: null });
  });
  it.each([{ ok: true }, { ok: true, portfolio: { items: [null], totalGhs: 0, investedGhs: null, gainGhs: null, byKind: [], usdGhs: null, unconverted: [] } }])("does not publish malformed portfolio success: %j", async payload => {
    mutations.request.mockResolvedValueOnce(payload);
    const { screen, changed, closed } = investmentComponent("AddInvestment"); screen.change("Name", "Sample new fund"); await screen.submitForm();
    expect(screen.button("Add").props.disabled).toBe(false); expect(changed).not.toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled(); expect(mutations.recover).toHaveBeenCalledOnce();
  });
  it("publishes a complete confirmed portfolio once and closes an addition", async () => {
    mutations.request.mockResolvedValueOnce({ ok: true, portfolio });
    const { screen, changed, closed } = investmentComponent("AddInvestment"); screen.change("Name", "Sample new fund"); await screen.submitForm();
    expect(changed).toHaveBeenCalledExactlyOnceWith(portfolio); expect(closed).toHaveBeenCalledOnce(); expect(screen.field("Name").props.value).toBe(""); expect(mutations.recover).not.toHaveBeenCalled();
  });
  it("clears value-update Saving after an unconfirmed result without publishing a portfolio", async () => {
    mutations.request.mockRejectedValueOnce(new Error("Result unconfirmed. Reload latest records."));
    const { screen, changed } = investmentComponent("InvestmentCard"); (screen.button("Update value").props.onClick as () => void)(); screen.render();
    const input = nodes(screen.tree).find(node => node.type === "input")!; (input.props.onChange as (event: unknown) => void)({ target: { value: "125" } }); screen.render(); await screen.submitForm();
    expect(screen.button("Save").props.disabled).toBe(false); expect(text(screen.tree)).toContain("Result unconfirmed. Reload latest records."); expect(changed).not.toHaveBeenCalled();
  });
});
