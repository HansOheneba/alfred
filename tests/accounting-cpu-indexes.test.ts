import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { accountBalances, validateAccountData } from "@/lib/finance/accounting/accounts";
import { hydrateAccountingSources, sourceMovements } from "@/lib/finance/accounting/sources";
import { accountingReportRows, buildAccountingView, projectAccountingTransactions } from "@/lib/finance/accounting/view";
import { withLedgerReceipts } from "@/lib/finance/accounting/receipts";
import type { AccountingState } from "@/lib/finance/accounting/types";
import { accountingCpuFixture, accountingCpuVariant, CPU_OWNER } from "./accounting-cpu-fixture";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("per-call accounting indexes", () => {
  it("preserves complete pre-optimization outputs for 2315 movements, 2277 snapshots and raw SMS evidence", () => {
    const { state, fresh, raw, messages } = accountingCpuFixture();
    const before = structuredClone({ state, fresh, raw, messages });
    const rows = accountingReportRows(state);
    // Captured from the unchanged source graph before editing the accounting functions.
    expect({
      source: digest(sourceMovements(CPU_OWNER, raw, messages)),
      hydrate: digest(hydrateAccountingSources(state, fresh)),
      balances: digest(accountBalances(state, "GHS")),
      view: digest(buildAccountingView(state, "GHS")),
      project: digest(projectAccountingTransactions(raw, state)),
      receipts: digest(withLedgerReceipts(rows, state, CPU_OWNER)),
    }).toEqual({
      source: "0c1d9f0dc20aa76232f5f32d5d81b9f96b1d290ec8ab17c7b42dca6a535c884a",
      hydrate: "ae97b6daff2c49cb52b9471b08e2057f1a5061b6448dce15ae824d5c20e3ef79",
      balances: "faad156a155ddcb9a2e1dd275ed4c2e57f7374882219db18d0c0dad74d4af250",
      view: "07f1779da663ec103844ad0ca6263361c2681db25cc2ee0b62930175fe65cb7f",
      project: "09803a7eee9c39906b60de90f749edca8c49475cb814484b7af42666028035d1",
      receipts: "242eb3cc78d07c3b6707edb8efabf3832207e5855d47625cbd370ebe0afa9b11",
    });
    expect({ state, fresh, raw, messages }).toEqual(before);
  });

  it("matches 256 original outputs across seeded missing/changed evidence, automatic links, fees, holds, duplicates and timestamp ties", () => {
    const matrix = Array.from({ length: 64 }, (_, seed) => {
      const f = accountingCpuVariant(seed);
      return digest({
        hydrate: hydrateAccountingSources(f.state, structuredClone(f.fresh)),
        balances: accountBalances(f.state, "GHS"),
        view: buildAccountingView(f.state, "GHS"),
        project: projectAccountingTransactions(f.raw, f.state),
      });
    });
    // Also compared directly against the detached, unchanged modules before recording this baseline.
    expect(digest(matrix)).toBe("6ae1970fc3e7f1640c66b4b0ff0450e55ff39cf111e56624e513be6347416c5a");
  });

  it("preserves account binding and explicit choices only for compatible accounts/current fingerprints", () => {
    for (let seed = 0; seed < 32; seed += 1) {
      const f = accountingCpuVariant(seed);
      f.state.transfers = [];
      const actual = hydrateAccountingSources(f.state, f.fresh);
      for (let index = 0; index < f.fresh.length; index += 1) {
        const source = f.fresh[index], prior = f.state.movements.find((row) => row.id === source.id)!;
        const row = actual.movements[index];
        expect(row.accountId).toBe(prior.accountId && f.state.accounts.some((account) => account.id === prior.accountId && account.currency === source.currency) ? prior.accountId : source.accountId);
        expect(row.status).toBe(prior.sourceFingerprint === source.sourceFingerprint ? prior.status : source.status);
        expect(row.sourceFingerprint).toBe(source.sourceFingerprint);
        expect(row.sourceText).toBe(source.sourceText);
      }
      for (const missing of actual.movements.slice(f.fresh.length)) {
        expect(missing).toMatchObject({ status: "excluded", sourceStatus: "excluded", sourceMissing: true });
      }
    }
  });

  it("selects the last appended current tie and the previous distinct timestamp, retaining incomplete evidence", () => {
    const { state } = accountingCpuFixture(3, 3);
    state.accounts = [state.accounts[0]]; state.transfers = [];
    state.movements.forEach((movement, index) => {
      movement.accountId = state.accounts[0].id; movement.status = "confirmed";
      movement.direction = "in"; movement.amountMinor = 500;
      movement.occurredAt = index ? "2026-01-01T00:10:00.000Z" : "2026-01-01T00:00:00.000Z";
      movement.reportedBalanceMinor = 90000 + index * 500;
      Object.assign(state.snapshots[index], { accountId: movement.accountId, balanceMinor: movement.reportedBalanceMinor, occurredAt: movement.occurredAt });
    });
    const stale = { ...state.snapshots[2], id: "stale-newest", occurredAt: "2027-01-01T00:00:00.000Z", sourceFingerprint: "stale" };
    state.snapshots.push(stale);
    const first = accountBalances(state, "GHS");
    expect(first.accounts[0]).toMatchObject({ snapshot: { id: state.snapshots[2].id }, reconciliation: { status: "matched", expectedMinor: 91000, differenceMinor: 0 } });
    expect(first.totalMinor).toBe(91000);
    state.movements[1].accountId = null;
    expect(accountBalances(state, "GHS").accounts[0].reconciliation).toMatchObject({ status: "incomplete", reason: expect.stringContaining("not been assigned") });
    expect(state.snapshots.at(-1)).toEqual(stale);
  });

  it.each([
    ["duplicate account", (state: AccountingState) => state.accounts.push({ ...state.accounts[0] }), "Duplicate account ID", "conflict"],
    ["duplicate movement", (state: AccountingState) => state.movements.push({ ...state.movements[0] }), "Duplicate movement ID", "conflict"],
    ["foreign movement", (state: AccountingState) => { state.movements[0].ownerId = "another-owner"; }, "Movement belongs to another owner", "ownership"],
    ["missing account", (state: AccountingState) => { state.snapshots[0].accountId = "missing-account"; }, "Account was not found", "not_found"],
    ["missing snapshot source", (state: AccountingState) => { state.snapshots[0].sourceMovementId = "missing-source"; }, "Snapshot source movement was not found", "not_found"],
    ["missing transfer source", (state: AccountingState) => { state.transfers[0].outgoing.movementId = "missing-transfer-source"; }, "Transfer movement was not found", "not_found"],
    ["unsafe amount", (state: AccountingState) => { state.movements[0].amountMinor = Number.MAX_SAFE_INTEGER; state.movements[0].feeMinor = 1; }, "Movement gross amount must be a safe integer", "validation"],
  ] as const)("retains full validation for %s", (_name, mutate, message, code) => {
    const { state } = accountingCpuFixture(6, 6);
    mutate(state);
    expect(() => validateAccountData(state)).toThrow(message);
    try { accountBalances(state, "GHS"); throw new Error("Expected accounting validation failure"); }
    catch (error) { expect(error).toMatchObject({ code, message: expect.stringContaining(message) }); }
  });

  it("bounds movement-identity scans without depending on wall-clock test timing", () => {
    const { state, fresh } = accountingCpuFixture();
    let reads = 0;
    state.movements = state.movements.map((movement) => new Proxy(movement, { get(target, key, receiver) { if (key === "id") reads += 1; return Reflect.get(target, key, receiver); } }));
    accountBalances(state, "GHS");
    expect(reads).toBeLessThan(30 * (state.movements.length + state.snapshots.length));
    reads = 0;
    hydrateAccountingSources(state, fresh);
    expect(reads).toBeLessThan(30 * (state.movements.length + state.snapshots.length));
    reads = 0;
    projectAccountingTransactions([], state);
    expect(reads).toBeLessThan(30 * (state.movements.length + state.snapshots.length));
  });
});
