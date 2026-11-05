import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AccountsReadClient } from "@/app/accounts/accounts-read-client";
import { projectAccountsReadView } from "@/lib/finance/accounting/read-view";
import { emptyAccountingState, type CashMovement } from "@/lib/finance/accounting/types";

vi.mock("@/app/components/app-shell", () => ({ usePrivacyMask: () => [false] }));
describe("paged Accounts preserves upstream uncounted movement presentation", () => {
  it("uses the shared desktop/mobile row labels, styling attributes and accessible names", () => {
    const ownerId = "fictional-status-owner", state = emptyAccountingState(ownerId);
    state.movements = ["excluded", "duplicate"].map((status, index): CashMovement => ({ id: `fictional-status:${index}`, ownerId, accountId: null, direction: "out", status: status as "excluded" | "duplicate",
      amountMinor: 100, feeMinor: 0, currency: "GHS", date: "2026-11-05", occurredAt: "2026-11-05T12:00:00.000Z", description: `Fictional ${status}`, category: "Other",
      sourceId: `fictional-source:${index}`, sourceKind: "manual", sourceFingerprint: `fictional-fingerprint:${index}`, legacyTransactionId: null, feeTransactionId: null, legacyClassification: null }));
    const initialView = projectAccountsReadView({ state, availability: "ready", sourceVersion: "fictional-source", rawTransactions: [] }, { currency: "GHS", section: "activity", page: 0 });
    const html = renderToStaticMarkup(createElement(AccountsReadClient, { initialView, expectedOwnerId: ownerId, defaultCurrency: "GHS" }));
    expect(html.match(/data-counted="false"/g)).toHaveLength(4);
    expect(html).toContain("Excluded · not counted"); expect(html).toContain("Duplicate · not counted");
    expect(html).toContain('aria-label="Open Fictional excluded, not counted"');
    expect(html).toContain('aria-label="Open Fictional duplicate, not counted"');
    expect(html).toContain("is-excluded"); expect(html).toContain("is-duplicate");
  });
});
