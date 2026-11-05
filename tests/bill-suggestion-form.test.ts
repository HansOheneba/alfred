import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BillForm, BillsCard } from "@/app/dashboard/bills-card";
import { Button, Dialog, DialogActions, Field } from "@/app/components/ui";
import { renewalSuggestionBillDraft } from "@/lib/finance/bill-renewals";
import type { BillAction } from "@/lib/finance/bill-schedule";
import type { BillRecord, RenewalSuggestion } from "@/lib/finance/bills";
type Setter<T> = (next: T | ((value: T) => T)) => void;
type State = { state<T>(initial: T | (() => T)): [T, Setter<T>] };
const hooks = vi.hoisted(() => ({ current: null as State | null, refresh: vi.fn() }));
vi.mock("react", async original => { const react = await original<typeof import("react")>(); return { ...react, useState: <T>(initial: T | (() => T)) => hooks.current ? hooks.current.state(initial) : react.useState(initial) }; });
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: hooks.refresh }) }));
type Element = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Element[] { return Array.isArray(node) ? node.flatMap(nodes) : isValidElement<Record<string, unknown>>(node) ? [node, ...nodes(node.props.children as ReactNode)] : []; }
function text(node: ReactNode): string { return typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(text).join("") : isValidElement<Record<string, unknown>>(node) ? text(node.props.children as ReactNode) : ""; }
function suggestion(changes: Partial<RenewalSuggestion> = {}): RenewalSuggestion { return { id: "sample-renewal", name: "Sample service", paymentCount: 3, lastDate: "2026-10-18", lastAmount: "72.50", currency: "GHS", expectedDate: "2026-11-18", cadence: "monthly", expectedAmount: null, variableAmount: true, basis: "Three recorded payments", ...changes }; }
class Screen implements State {
  private values: unknown[] = []; private index = 0; value!: ReactNode;
  constructor(private readonly content: () => ReactNode) {}
  state<T>(initial: T | (() => T)): [T, Setter<T>] { const index = this.index++; if (!(index in this.values)) this.values[index] = typeof initial === "function" ? (initial as () => T)() : initial; return [this.values[index] as T, next => { this.values[index] = typeof next === "function" ? (next as (previous: T) => T)(this.values[index] as T) : next; }]; }
  render() { this.index = 0; hooks.current = this; try { this.value = this.content(); } finally { hooks.current = null; } return this; }
  get dialog() { return nodes(this.value).find(node => node.type === Dialog)!; }
  button(label: string) { return nodes(this.value).find(node => node.type === Button && text(node.props.children as ReactNode) === label)!; }
  click(label: string) { (this.button(label).props.onClick as () => void)(); return this.render(); }
  field(label: string) { const node = nodes(this.value).find(node => node.type === Field && node.props.label === label)!; return nodes(node.props.children as ReactNode)[0]; }
  change(label: string, value: string) { (this.field(label).props.onChange as (event: { target: { value: string } }) => void)({ target: { value } }); return this.render(); }
}
afterEach(() => { hooks.current = null; vi.clearAllMocks(); });
describe("renewal suggestion confirmation", () => {
  it("prefills the latest observed amount for a variable candidate without changing its date, currency or cadence", () => {
    const value = suggestion(), before = structuredClone(value);
    expect(renewalSuggestionBillDraft(value)).toEqual({ name: "Sample service", nextDate: "2026-11-18", amount: "72.50", currency: "GHS", cadence: "monthly" });
    expect(value).toEqual(before);
  });
  it.each(["once", "weekly", "monthly", "yearly"] as const)("keeps the detected %s cadence and explicit expected amount", cadence => {
    expect(renewalSuggestionBillDraft(suggestion({ cadence, expectedAmount: "88.25", lastAmount: "72.50", expectedDate: "2027-01-31", currency: "USD" }))).toMatchObject({ cadence, nextDate: "2027-01-31", amount: "88.25", currency: "USD" });
  });
  it.each(["Confirm", "Add"])("maps the %s suggestion entrypoint to the same labelled confirmation form without saving", label => {
    const onAction = vi.fn(), card = new Screen(() => BillsCard({ bills: [], upcoming: [], suggestions: [suggestion()], currency: "GHS", today: "2026-11-04", onAction })).render().click(label);
    expect(card.dialog.props.title).toBe("Confirm bill");
    const form = nodes(card.value).find(node => node.type === BillForm)!;
    expect(form.props.initial).toMatchObject({ amount: "72.50", nextDate: "2026-11-18", currency: "GHS", cadence: "monthly", variableEstimate: true, lastPayment: { amount: "72.50", date: "2026-10-18" } });
    expect(onAction).not.toHaveBeenCalled();
    const screen = new Screen(() => BillForm(form.props as unknown as Parameters<typeof BillForm>[0])).render();
    expect(screen.field("Expected amount (GHS)").props.value).toBe("72.50"); expect(screen.field("Next payment date").props.value).toBe("2026-11-18");
    expect(nodes(screen.value).find(node => node.type === Field && node.props.label === "Expected amount (GHS)")?.props.hint).toContain("latest payment");
    expect(screen.button("Confirm bill")).toBeTruthy();
    expect(nodes(card.value).filter(node => node.type === Button && text(node.props.children as ReactNode) === "Close")).toHaveLength(0);
  });
  it("gives different bill drafts different form identities so switching records remounts local form state", () => {
    const bills: BillRecord[] = [0, 1].map(index => ({ id: `sample-${index}`, ownerId: "sample-owner", name: `Sample bill ${index}`, nextDate: index ? "2026-12-20" : "2026-11-10", amount: index ? "90.00" : "30.00", currency: index ? "USD" : "GHS", cadence: index ? "yearly" : "monthly", active: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }));
    const card = new Screen(() => BillsCard({ bills, upcoming: [], suggestions: [], currency: "GHS", today: "2026-11-04" })).render();
    const edits = nodes(card.value).filter(node => node.type === Button && text(node.props.children as ReactNode) === "Edit");
    (edits[0].props.onClick as () => void)(); card.render(); const first = nodes(card.value).find(node => node.type === BillForm)!;
    (edits[1].props.onClick as () => void)(); card.render(); const second = nodes(card.value).find(node => node.type === BillForm)!;
    expect(first.key).not.toBe(second.key); expect(second.props.currency).toBe("USD");
    const screen = new Screen(() => BillForm(second.props as unknown as Parameters<typeof BillForm>[0])).render();
    expect(screen.field("Name").props.value).toBe("Sample bill 1"); expect(screen.field("Expected amount (USD)").props.value).toBe("90.00"); expect(screen.field("Next payment date").props.value).toBe("2026-12-20");
  });
  it("keeps saved variable bills variable and only saves after an explicit submit", async () => {
    const action = vi.fn().mockResolvedValue(undefined), saved = vi.fn(), busy = vi.fn();
    const screen = new Screen(() => BillForm({ initial: { id: "sample-variable", amount: null, name: "Sample variable", nextDate: "2026-11-30", cadence: "monthly", currency: "GHS" }, currency: "GHS", today: "2026-11-04", onCancel: vi.fn(), onSaved: saved, onAction: action, onBusyChange: busy })).render();
    expect(nodes(screen.value).find(node => node.type === "input" && node.props.type === "checkbox")?.props.checked).toBe(true); expect(action).not.toHaveBeenCalled();
    const form = nodes(screen.value).find(node => node.type === "form")!; (form.props.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault: vi.fn() });
    await Promise.resolve(); await Promise.resolve();
    expect(action).toHaveBeenCalledWith({ action: "save", id: "sample-variable", name: "Sample variable", nextDate: "2026-11-30", cadence: "monthly", amount: null } satisfies BillAction);
    expect(saved).toHaveBeenCalledOnce(); expect(busy.mock.calls).toEqual([[true], [false]]);
  });
  it("keeps confirmation edits and errors available when a save fails", async () => {
    const action = vi.fn().mockRejectedValue(new Error("Synthetic save failed")), saved = vi.fn();
    const screen = new Screen(() => BillForm({ initial: { ...renewalSuggestionBillDraft(suggestion()), suggestionId: "sample" }, currency: "GHS", today: "2026-11-04", onCancel: vi.fn(), onSaved: saved, onAction: action })).render().change("Expected amount (GHS)", "80.00").change("Next payment date", "2026-11-21");
    const form = nodes(screen.value).find(node => node.type === "form")!; (form.props.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault: vi.fn() });
    await Promise.resolve(); await Promise.resolve(); screen.render();
    expect(saved).not.toHaveBeenCalled(); expect(screen.field("Expected amount (GHS)").props.value).toBe("80.00"); expect(screen.field("Next payment date").props.value).toBe("2026-11-21");
    expect(text(screen.value)).toContain("Synthetic save failed"); expect(action).toHaveBeenCalledWith(expect.objectContaining({ amount: "80.00", nextDate: "2026-11-21" }));
  });
  it("groups Back and the primary submit in the shared footer without a redundant Close action", () => {
    const screen = new Screen(() => BillForm({ initial: {}, currency: "GHS", today: "2026-11-04", onCancel: vi.fn(), onSaved: vi.fn() })).render();
    const footer = nodes(screen.value).find(node => node.type === DialogActions)!;
    expect(nodes(footer).filter(node => node.type === Button).map(node => text(node.props.children as ReactNode))).toEqual(["Back", "Save bill"]);
  });
  it("retains the observed payment amount and date as a read-only reference when the user chooses variable amounts", () => {
    const screen = new Screen(() => BillForm({ initial: { amount: "72.50", nextDate: "2026-11-18", suggestionId: "sample", lastPayment: { amount: "72.50", date: "2026-10-18" } }, currency: "GHS", today: "2026-11-04", onCancel: vi.fn(), onSaved: vi.fn() })).render().change("Expected amount (GHS)", "80.00");
    const checkbox = nodes(screen.value).find(node => node.type === "input" && node.props.type === "checkbox")!;
    (checkbox.props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } }); screen.render();
    const reference = nodes(screen.value).find(node => node.props["aria-label"] === "Previous payment reference")!;
    expect(text(reference)).toContain("Last recorded payment"); expect(text(reference)).toContain("72.50"); expect(text(reference)).not.toContain("80.00");
    expect(nodes(reference).find(node => node.type === "time")?.props.dateTime).toBe("2026-10-18");
    expect(text(reference)).toContain("Reference only"); expect(nodes(reference).some(node => node.type === "input")).toBe(false);
    expect(nodes(screen.value).some(node => node.type === Field && node.props.label === "Expected amount (GHS)")).toBe(false);
  });
  it("never turns the next due date or an edited expected amount into invented payment history", () => {
    const screen = new Screen(() => BillForm({ initial: { id: "sample-variable", amount: null, nextDate: "2026-11-18" }, currency: "GHS", today: "2026-11-04", onCancel: vi.fn(), onSaved: vi.fn() })).render();
    const reference = nodes(screen.value).find(node => node.props["aria-label"] === "Previous payment reference")!;
    expect(text(reference)).toContain("No previous payment details are available"); expect(nodes(reference).some(node => node.type === "time")).toBe(false);
    const withAmount = new Screen(() => BillForm({ initial: { id: "sample-variable", amount: null, lastPayment: { amount: "72.50" }, nextDate: "2026-11-18" }, currency: "GHS", today: "2026-11-04", onCancel: vi.fn(), onSaved: vi.fn() })).render();
    expect(text(withAmount.value)).toContain("Date not available"); expect(nodes(withAmount.value).some(node => node.type === "time")).toBe(false);
  });
  it("separates confirmed fixed amounts by currency and excludes variable bills and unconfirmed estimates", () => {
    const base: BillRecord = { id: "sample-fixed", ownerId: "sample-owner", name: "Sample fixed", nextDate: "2026-11-10", amount: "100.00", currency: "GHS", cadence: "monthly", active: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
    const bills = [base, { ...base, id: "sample-usd", name: "Sample dollars", currency: "USD", amount: "20.00" }, { ...base, id: "sample-variable", name: "Sample variable", amount: null }];
    const card = new Screen(() => BillsCard({ bills, upcoming: bills.map(bill => ({ ...bill, renewalDate: bill.nextDate })), suggestions: [suggestion()], currency: "GHS", today: "2026-11-04" })).render();
    expect(text(card.value)).toContain("Confirmed bills · fixed amounts"); expect(text(card.value)).toContain("100.00"); expect(text(card.value)).toContain("20.00"); expect(text(card.value)).not.toContain("120.00");
    expect(text(card.value)).toContain("1 variable bill is not included in this total"); expect(text(card.value)).toContain("Unconfirmed suggestions. Estimates are not included");
  });
  it("shows readable saving status and passes the saved plan to the receipt only after success", async () => {
    let finish!: () => void;
    const action = vi.fn(() => new Promise<void>(resolve => { finish = resolve; })), saved = vi.fn();
    const screen = new Screen(() => BillForm({ initial: { name: "Sample service", nextDate: "2026-11-18", cadence: "monthly", amount: "72.5" }, currency: "GHS", today: "2026-11-04", onCancel: vi.fn(), onSaved: saved, onAction: action })).render();
    (nodes(screen.value).find(node => node.type === "form")!.props.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault: vi.fn() }); screen.render();
    expect(text(screen.value)).toContain("Saving your bill…"); expect(screen.field("Name").props.disabled).toBe(true); expect(saved).not.toHaveBeenCalled();
    finish(); await Promise.resolve(); await Promise.resolve();
    expect(saved).toHaveBeenCalledWith({ name: "Sample service", nextDate: "2026-11-18", cadence: "monthly", amount: "72.50", currency: "GHS" });
  });
  it("provides View bill after a save without requiring a second confirmation or fabricating a payment receipt", () => {
    const card = new Screen(() => BillsCard({ bills: [], upcoming: [], suggestions: [suggestion()], currency: "GHS", today: "2026-11-04" })).render().click("Confirm");
    const form = nodes(card.value).find(node => node.type === BillForm)!;
    (form.props.onSaved as (bill: unknown) => void)({ name: "Sample service", nextDate: "2026-11-18", cadence: "monthly", amount: null, currency: "GHS" }); card.render().click("View bill");
    const receipt = nodes(card.value).find(node => node.type === Dialog && node.props.title === "Saved bill details")!;
    expect(receipt.props.open).toBe(true); expect(text(receipt)).toContain("saved bill plan, not a recorded payment"); expect(text(receipt)).toContain("Amount varies"); expect(text(receipt)).toContain("excluded from fixed planned totals");
    expect(nodes(receipt).some(node => node.type === Button && text(node.props.children as ReactNode) === "Confirm bill")).toBe(false);
  });
});
