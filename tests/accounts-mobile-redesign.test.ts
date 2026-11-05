import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountsWorkspace, movementDirectionLabel, movementStatusLabel } from "@/app/accounts/accounts-workspace";
import { emptyAccountingState, type AccountingState, type CashMovement } from "@/lib/finance/accounting/types";
const selected = vi.hoisted(() => ({ tab: "accounts" }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  return { ...react, useSyncExternalStore: (subscribe: Parameters<typeof react.useSyncExternalStore>[0], snapshot: () => unknown, serverSnapshot: () => unknown) => react.useSyncExternalStore(subscribe, snapshot, subscribe.name === "subscribeTab" ? () => selected.tab : serverSnapshot) };
});
vi.mock("@/app/components/app-shell", () => ({ usePrivacyMask: () => [false] }));
function sample() {
  const state = emptyAccountingState("sample-owner");
  state.accounts = [{ id: "sample-cash", label: "Everyday wallet", provider: "Fictional provider", currency: "GHS", includeInCash: true, createdAt: "2026-11-01T12:00:00Z" }];
  const movement: CashMovement = { id: "sample-out", ownerId: state.ownerId, accountId: "sample-cash", direction: "out", status: "confirmed", amountMinor: 1200, feeMinor: 25, taxMinor: 5, currency: "GHS", date: "2026-11-01", occurredAt: "2026-11-01T12:00:00Z", description: "Sample lunch", category: "Food", sourceId: "sample-evidence", sourceKind: "manual", sourceFingerprint: "sample-fingerprint", sourceText: "Fictional source evidence", legacyTransactionId: null, feeTransactionId: null, legacyClassification: null };
  state.movements = [movement];
  return state;
}
function render(state: AccountingState, props: Partial<Parameters<typeof AccountsWorkspace>[0]> = {}) { return renderToStaticMarkup(createElement(AccountsWorkspace, { state, mode: "live", dispatch: vi.fn(), ...props })); }
function receipt(markup: string) { return markup.match(/<section[^>]*role="dialog"[\s\S]*?<\/section>/)?.[0] ?? ""; }
beforeEach(() => { selected.tab = "accounts"; });
describe("Accounts balance and activity layout", () => {
  it("defaults to Activity beneath one collapsed balance disclosure while retaining account tools", () => {
    const state = sample(), before = structuredClone(state), html = render(state);
    expect(html).toContain('<details class="alfred-accounts-balanceDisclosure">');
    expect(html).toContain("Latest reported balances · Not live");
    expect(html).toContain("Everyday wallet"); expect(html).toContain("Add account");
    expect(html).toContain('aria-label="Activity views"'); expect(html).toContain('id="accounts-panel-activity"');
    expect(html).not.toContain('aria-label="Account workspace"');
    expect(html.indexOf('alfred-accounts-balanceCard')).toBeLessThan(html.indexOf('id="accounts-activity-title"'));
    expect(html).toContain('class="alfred-accounts-movementRow"'); expect(html).toContain('aria-label="Open Sample lunch"');
    expect(state).toEqual(before);
  });
  it("names custom filter triggers from their visible labels during server rendering", () => {
    const html = render(sample());
    for (const label of ["Account", "Status"]) {
      const labelId = html.match(new RegExp(`<span id="([^"]+)">${label}</span>`))?.[1];
      expect(labelId).toBeTruthy();
      const trigger = html.match(new RegExp(`<button[^>]*role="combobox"[^>]*aria-labelledby="${labelId}"[^>]*>`))?.[0];
      expect(trigger).toBeTruthy();
    }
    expect(html).toContain('class="alfred-select-native"');
  });
  it("keeps incomplete balance warnings visible before the collapsed account content", () => {
    const html = render(sample());
    expect(html.indexOf("Total is incomplete.")).toBeGreaterThan(0);
    expect(html.indexOf("Total is incomplete.")).toBeLessThan(html.indexOf('class="alfred-accounts-balanceDisclosure"'));
  });
  it.each(["needs-attention", "settlements", "subscriptions"])("preserves the %s deep link as an Activity view", tab => {
    selected.tab = tab;
    expect(render(sample())).toContain(`id="accounts-panel-${tab}"`);
  });
  it("does not expose saving controls as enabled when account storage is unavailable", () => {
    const html = render(sample(), { availability: "migration-required" });
    expect(html).toContain("Changes cannot be saved yet.");
    expect(html).toMatch(/disabled=""[^>]*><svg[^]*?<\/svg> Add account<\/button>/);
  });
});
describe("transaction receipt", () => {
  it("opens with readable facts, amount, direction and edit action instead of classification inputs", () => {
    const state = sample(), html = receipt(render(state, { initialPaymentMovementId: "sample-out" }));
    expect(html).toContain('aria-label="Transaction details"');
    expect(html).toContain("Money out"); expect(html).toContain("−GH₵12.00");
    expect(html).toContain("Everyday wallet"); expect(html).toContain("Food"); expect(html).toContain("Confirmed");
    expect(html).toContain("Fee"); expect(html).toContain("GH₵0.25"); expect(html).toContain("Tax"); expect(html).toContain("GH₵0.05");
    expect(html).toContain("Edit details"); expect(html).not.toContain("<select"); expect(html).not.toContain("Save classification");
    expect(html).toContain('<details class="alfred-account-evidence">'); expect(html).toContain("Fictional source evidence");
  });
  it("keeps linked classifications protected while preserving the source receipt", () => {
    const state = sample(); state.settlements = [{ id: "sample-refund", kind: "refund", original: { movementId: "sample-out", sourceFingerprint: "sample-fingerprint" }, returns: [], createdAt: "2026-11-01T12:00:00Z" }];
    const html = receipt(render(state, { initialPaymentMovementId: "sample-out" }));
    expect(html).toContain("Linked to a transfer, refund or loan."); expect(html).not.toContain("Edit details"); expect(html).toContain("Fictional source evidence");
  });
  it("retains explicit missing-time evidence rather than inventing a timestamp", () => {
    const state = sample(); state.movements[0].occurredAt = null;
    const html = receipt(render(state, { initialPaymentMovementId: "sample-out" }));
    expect(html).toContain("1 Nov 2026 · Time not recorded");
  });
  it("does not label internal movement as incoming or hide meaningful statuses", () => {
    expect(movementDirectionLabel("internal")).toBe("Internal movement");
    expect(movementDirectionLabel("in")).toBe("Money in"); expect(movementDirectionLabel("out")).toBe("Money out");
    expect(movementStatusLabel("review")).toBe("Needs review"); expect(movementStatusLabel("hold")).toBe("On hold"); expect(movementStatusLabel("transfer")).toBe("Own-account transfer");
  });
});
