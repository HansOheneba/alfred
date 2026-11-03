import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createSubscriptionsResource } from "@/app/accounts/subscriptions-resource";
import { subscriptionsData } from "@/app/accounts/subscriptions-data";
import { SubscriptionsPanel } from "@/app/accounts/subscriptions-panel";
import { subscriptionReloadFailed } from "@/app/accounts/subscriptions-state";
import type { SubscriptionsResult } from "@/app/accounts/subscriptions-actions";
import { emptyAccountingState, type AccountingState, type CashMovement } from "@/lib/finance/accounting/types";
import { applyAccountingAction } from "@/lib/finance/accounting/reducer";
import type { BillRecord } from "@/lib/finance/bills";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const OWNER = "fictional-owner", TODAY = "2026-11-02", NOW = `${TODAY}T12:00:00Z`;
const facts = (bills: BillRecord[] = []) => ({ bills, today: TODAY, currency: "GHS" });
const response = (bills: BillRecord[] = [], ownerId = OWNER): SubscriptionsResult => ({ ok: true, ownerId, data: facts(bills) });
const bill = (name = "Fictional subscription"): BillRecord => ({ id: "fictional-bill", ownerId: OWNER, name, nextDate: "2026-11-15", amount: "100.00", currency: "GHS", cadence: "monthly", active: true, createdAt: NOW, updatedAt: NOW });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function state(): AccountingState {
  const result = emptyAccountingState(OWNER);
  result.accounts = ["a", "b"].map((id) => ({ id, label: `Fictional ${id}`, provider: "Cash", currency: "GHS", includeInCash: true, createdAt: NOW }));
  result.movements = ["2026-10-01", "2026-11-01"].map((date, index): CashMovement => ({ id: `out${index}`, ownerId: OWNER, accountId: "a", direction: "out", status: "confirmed", sourceStatus: "confirmed", amountMinor: 10000, feeMinor: 200, taxMinor: 100, currency: "GHS", date, occurredAt: `${date}T12:00:00Z`, description: "Netflix", category: "Subscriptions", sourceId: `source${index}`, sourceKind: "manual", sourceFingerprint: `fingerprint${index}`, legacyTransactionId: null, feeTransactionId: null, legacyClassification: null }));
  return result;
}
const ref = (movement: CashMovement) => ({ movementId: movement.id, sourceFingerprint: movement.sourceFingerprint });
const markup = (resource: ReturnType<typeof createSubscriptionsResource>, accounting = emptyAccountingState(OWNER)) => renderToStaticMarkup(createElement(SubscriptionsPanel, { resource, accounting }));

describe("subscription resource lifecycle", () => {
  it("keeps freshly saved bill data across tab unmount/remount without replaying an old seed", async () => {
    let bills = [bill("Original service")];
    const read = vi.fn(async () => response(structuredClone(bills)));
    const write = vi.fn(async () => { bills = [bill("Updated service")]; });
    const resource = createSubscriptionsResource(OWNER, read, write), firstMount = vi.fn();
    const unmount = resource.subscribe(firstMount);
    expect(read).not.toHaveBeenCalled();
    await resource.ensureLoaded(); expect(markup(resource)).toContain("Original service");
    await resource.save({ action: "save", id: "fictional-bill", name: "Updated service", nextDate: "2026-11-15", amount: "100.00", cadence: "monthly" });
    expect(markup(resource)).toContain("Updated service");
    unmount(); const secondMount = vi.fn(), stop = resource.subscribe(secondMount);
    await resource.ensureLoaded();
    expect(markup(resource)).toContain("Updated service"); expect(markup(resource)).not.toContain("Original service");
    expect(read).toHaveBeenCalledTimes(2); expect(write).toHaveBeenCalledOnce(); stop();
  });
  it("clears cards throughout saved-write reload failure and retry, then recovers", async () => {
    const refresh = deferred<SubscriptionsResult>();
    const read = vi.fn().mockResolvedValueOnce(response([bill()])).mockRejectedValueOnce(new Error("offline")).mockImplementationOnce(() => refresh.promise);
    const resource = createSubscriptionsResource(OWNER, read, vi.fn(async () => undefined));
    await resource.ensureLoaded();
    await resource.save({ action: "delete", id: "fictional-bill" });
    expect(resource.getSnapshot()).toEqual({ kind: "error", text: subscriptionReloadFailed });
    expect(markup(resource)).not.toContain("Fictional subscription");
    const retry = resource.reload(); expect(resource.getSnapshot()).toEqual({ kind: "loading" });
    expect(markup(resource)).toContain("Loading your subscriptions"); expect(markup(resource)).not.toContain("Retry subscriptions");
    refresh.resolve(response([bill("Recovered service")])); await retry;
    expect(markup(resource)).toContain("Recovered service");
  });
  it("rejects wrong-owner data, isolates owner instances and ignores an old read after save", async () => {
    const old = deferred<SubscriptionsResult>();
    const read = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValueOnce(response([bill("Current service")]));
    const a = createSubscriptionsResource(OWNER, read, vi.fn(async () => undefined));
    const pending = a.ensureLoaded(); await Promise.resolve();
    await a.save({ action: "delete", id: "fictional-bill" });
    old.resolve(response([bill("Stale service")])); await pending;
    expect(markup(a)).toContain("Current service"); expect(markup(a)).not.toContain("Stale service");
    const b = createSubscriptionsResource("fictional-owner-b", async () => response([bill("Owner A private service")]), vi.fn());
    await b.ensureLoaded(); expect(b.getSnapshot().kind).toBe("error"); expect(b.getSnapshot()).not.toHaveProperty("data");
    const bMarkup = markup(b, emptyAccountingState("fictional-owner-b"));
    expect(bMarkup).toContain("signed-in account changed"); expect(bMarkup).not.toContain("Owner A private service");
  });
  it("does not claim a rejected write succeeded and does not refresh or reuse stale cards", async () => {
    const read = vi.fn(async () => response([bill()]));
    const resource = createSubscriptionsResource(OWNER, read, async () => { throw new Error("That bill could not be saved."); });
    await resource.ensureLoaded();
    await expect(resource.save({ action: "delete", id: "fictional-bill" })).rejects.toThrow("could not be saved");
    expect(read).toHaveBeenCalledOnce(); expect(markup(resource)).toContain("could not be saved");
    expect(markup(resource)).not.toContain("Your change was saved"); expect(markup(resource)).not.toContain("Fictional subscription");
  });
});

describe("current accounting renewal projection", () => {
  it("uses current canonical principal, keeps separate fees/tax out of renewal amount and recomputes category edits without reads", async () => {
    const accounting = state(), read = vi.fn(async () => response());
    const resource = createSubscriptionsResource(OWNER, read, vi.fn()); await resource.ensureLoaded();
    expect(subscriptionsData(facts(), accounting).suggestions[0]).toMatchObject({ name: "Netflix", paymentCount: 2, lastAmount: "100.00", expectedAmount: "100.00" });
    const excluded = applyAccountingAction(accounting, { type: "classify_movement", movement: ref(accounting.movements[1]), status: "excluded", expectedRevision: 0, requestId: "exclude" }, NOW);
    expect(subscriptionsData(facts(), excluded).suggestions).toEqual([]);
    expect(markup(resource, accounting)).toContain("Netflix"); expect(markup(resource, excluded)).not.toContain("Netflix");
    const custom = state(); custom.movements.forEach((movement) => { movement.description = "Fictional streaming"; });
    const edit = applyAccountingAction(custom, { type: "classify_movement", movement: ref(custom.movements[1]), status: "confirmed", category: "Other", expectedRevision: 0, requestId: "category" }, NOW);
    expect(subscriptionsData(facts(), custom).suggestions).toHaveLength(1); expect(subscriptionsData(facts(), edit).suggestions).toEqual([]);
    expect(read).toHaveBeenCalledOnce();
  });
  it("reflects partial refunds, loan exclusions and own-account transfers through real accounting actions", () => {
    const accounting = state(), original = accounting.movements[1];
    const incoming = { ...original, id: "incoming", accountId: "b", direction: "in" as const, amountMinor: 4000, feeMinor: 0, taxMinor: 0, sourceId: "incoming-source", sourceFingerprint: "incoming-fingerprint" };
    accounting.movements.push(incoming);
    const refund = applyAccountingAction(accounting, { type: "save_settlement", settlement: { id: "refund", kind: "refund", original: ref(original), returns: [{ ...ref(incoming), principalMinor: 4000 }] }, expectedRevision: 0, requestId: "refund" }, NOW);
    expect(subscriptionsData(facts(), refund).suggestions[0]).toMatchObject({ paymentCount: 2, lastAmount: "60.00", variableAmount: true });
    const loan = applyAccountingAction(accounting, { type: "save_settlement", settlement: { id: "loan", kind: "loan", original: ref(original), returns: [] }, expectedRevision: 0, requestId: "loan" }, NOW);
    expect(subscriptionsData(facts(), loan).suggestions).toEqual([]);
    incoming.amountMinor = original.amountMinor;
    const transfer = applyAccountingAction(accounting, { type: "pair_transfer", id: "transfer", outgoing: ref(original), incoming: ref(incoming), expectedRevision: 0, requestId: "transfer" }, NOW);
    expect(subscriptionsData(facts(), transfer).suggestions).toEqual([]);
  });
});
