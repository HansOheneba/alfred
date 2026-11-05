import { describe, expect, it, vi } from "vitest";
import { loadAccountRulesInputs } from "@/app/settings/account-rules-data";
import { emptyAccountRuleState } from "@/lib/account-rules/types";
import { projectAccountsReadView } from "@/lib/finance/accounting/read-view";
import { emptyAccountingState } from "@/lib/finance/accounting/types";

const OWNER = "fictional-rules-owner", OTHER = "fictional-other-owner", AT = "2026-11-05T12:00:00Z";
const state = emptyAccountingState(OWNER);
state.accounts = [{ id: "sample-wallet", label: "Sample wallet", provider: "Sample provider", currency: "GHS", includeInCash: true, createdAt: AT }];
const view = projectAccountsReadView({ state, availability: "ready", sourceVersion: "fictional-source", rawTransactions: [] }, { currency: "GHS", section: "activity", page: 0 });
const rules = { state: emptyAccountRuleState(OWNER), availability: "ready" as const };
function request(overrides: { rules?: unknown; view?: unknown; rulesStatus?: number; viewStatus?: number } = {}) {
  return vi.fn<typeof fetch>(async url => {
    if (String(url) === "/api/account-rules") return Response.json(overrides.rules ?? { ok: true, ...rules }, { status: overrides.rulesStatus ?? 200 });
    if (String(url).startsWith("/api/accounts/view?")) return Response.json({ ok: true, view: overrides.view ?? view }, { status: overrides.viewStatus ?? 200 });
    throw new Error("Unexpected resource; full accounting state must never be requested");
  });
}

describe("compact owner-bound Settings rule inputs", () => {
  it("loads account identities from the bounded read DTO without requesting or manufacturing AccountingState", async () => {
    const network = request();
    const result = await loadAccountRulesInputs(OWNER, network);
    expect(result).toEqual({ ...rules, accounts: [{ id: "sample-wallet", label: "Sample wallet", provider: "Sample provider", currency: "GHS" }] });
    expect(network.mock.calls.map(call => String(call[0]))).toEqual(["/api/account-rules", "/api/accounts/view?section=activity&page=0"]);
    expect(network.mock.calls.every(call => !call[1]?.method || call[1]?.method === "GET")).toBe(true);
    for (const call of network.mock.calls) expect(call[1]).toMatchObject({ cache: "no-store", credentials: "same-origin" });
    const serialized = JSON.stringify(result);
    for (const unused of ["movements", "snapshots", "sourceFingerprint", "sourceText", "includeInCash", "createdAt"]) expect(serialized).not.toContain(unused);
  });
  it("does not start a private read without the displayed Settings owner", async () => {
    const network = request();
    await expect(loadAccountRulesInputs(undefined, network)).rejects.toThrow("signed-in account");
    expect(network).not.toHaveBeenCalled();
  });
  it.each(["rules", "accounts"])("rejects cross-session %s before publishing rule/account data", async kind => {
    const network = request(kind === "rules" ? { rules: { ok: true, ...rules, state: emptyAccountRuleState(OTHER) } } : { view: { ...view, ownerId: OTHER } });
    await expect(loadAccountRulesInputs(OWNER, network)).rejects.toThrow();
  });
  it.each(["rules", "accounts"])("preserves unavailable %s storage without inventing readiness", async kind => {
    const network = request(kind === "rules" ? { rules: { ok: true, ...rules, availability: "migration-required" } } : { view: { ...view, availability: "migration-required" } });
    expect((await loadAccountRulesInputs(OWNER, network)).availability).toBe("migration-required");
  });
  it("does not replace a failed or malformed read with zeroed account/rule state", async () => {
    await expect(loadAccountRulesInputs(OWNER, request({ rulesStatus: 503, rules: { ok: false, text: "Synthetic rules unavailable" } }))).rejects.toThrow("unavailable");
    await expect(loadAccountRulesInputs(OWNER, request({ rules: { ok: true, state: {}, availability: "ready" } }))).rejects.toThrow("could not be loaded");
    await expect(loadAccountRulesInputs(OWNER, request({ view: { ...view, accounts: [{ id: 7 }] } }))).rejects.toThrow("account names");
  });
});
