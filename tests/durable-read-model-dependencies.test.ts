import { describe, expect, it } from "vitest";
import { hydrateAccountingSources, sourceMovements } from "@/lib/finance/accounting/sources";
import { accountingReportRows } from "@/lib/finance/accounting/view";
import { accountingCpuFixture, CPU_OWNER } from "./accounting-cpu-fixture";

describe("dependency hazards for a future incremental display projector", () => {
  it("cannot use the last hydrated display as the saved manual-override base", () => {
    const { state, fresh } = accountingCpuFixture(1, 0);
    state.movements[0] = { ...state.movements[0], category: "Fictional custom category", categoryOrigin: "manual", status: "confirmed" };
    const saved = structuredClone(state);
    const missingDisplay = hydrateAccountingSources(saved, []);
    expect(missingDisplay.movements[0]).toMatchObject({ sourceMissing: true, status: "excluded" });

    const correct = hydrateAccountingSources(saved, fresh);
    const naiveIncremental = hydrateAccountingSources(missingDisplay, fresh);
    expect(correct.movements[0]).toMatchObject({ category: "Fictional custom category", categoryOrigin: "manual", status: "confirmed" });
    expect(naiveIncremental.movements[0].category).toBe("Food");
    expect(naiveIncremental.movements[0].category).not.toBe(correct.movements[0].category);
    expect(state).toEqual(saved);
  });

  it("cannot use only the parent movement fingerprint to detect a changed fee report entry", () => {
    const { state, raw, messages } = accountingCpuFixture(1, 0);
    const message = { ...messages[0], status: "skipped" as const, fee: "1.50", feeTransactionId: "fictional-fee" };
    const fee = { ...raw[0], transactionId: "fictional-fee", amount: "1.50", category: "Fees", sourceUpdateId: `bank:${message.id}:fee` };
    const before = sourceMovements(CPU_OWNER, [...raw, fee], [message]);
    const after = sourceMovements(CPU_OWNER, [...raw, { ...fee, status: "deleted" as const }], [message]);
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(after[0].sourceFingerprint).toBe(before[0].sourceFingerprint);
    expect(before[0].confirmedFeeMinor).toBe(150);
    expect(after[0].confirmedFeeMinor).toBe(0);
    expect(accountingReportRows({ ...state, movements: before })).toMatchObject([{ category: "Fees", minor: 150 }]);
    expect(accountingReportRows({ ...state, movements: after })).toEqual([]);
  });
});
