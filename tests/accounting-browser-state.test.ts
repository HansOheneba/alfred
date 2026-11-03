import { describe, expect, it } from "vitest";

import { browserAccountingState } from "@/lib/finance/accounting/browser-state";
import { emptyAccountingState, type AccountingState } from "@/lib/finance/accounting/types";

describe("browser accounting state", () => {
  it("keeps undo entries but drops their full before-state copies", () => {
    const base = emptyAccountingState("owner-1");
    const account = { id: "a1", label: "Synthetic wallet" } as AccountingState["accounts"][number];
    const state: AccountingState = { ...base, revision: 2, accounts: [account], audit: [
      { id: "u1", requestId: "r1", action: "create_account", actionFingerprint: "f1", at: "2026-11-02T00:00:00.000Z", revision: 1, before: { accounts: [account], movements: [], snapshots: [], transfers: [], settlements: [] } },
    ] };
    const sent = browserAccountingState(state);
    expect(sent.audit).toHaveLength(1);
    expect(sent.audit[0]).toMatchObject({ id: "u1", revision: 1 });
    expect(sent.audit[0].before.accounts).toEqual([]);
    expect(sent.accounts).toEqual([account]);
    expect(state.audit[0].before.accounts).toHaveLength(1);
  });
});
