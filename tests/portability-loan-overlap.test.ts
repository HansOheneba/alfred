import { expect, it } from "vitest";
import { nativeLoanOverlapConflicts } from "@/lib/portability/loan-overlap";
import type { ImportArchive } from "@/lib/portability/model";
const archive = (): ImportArchive => ({ archiveId: "a".repeat(64), manifest: { namespace: "synthetic", sourceApp: "alfred", exportedAt: "2026-01-01T00:00:00.000Z", coverage: [] }, datasets: { movements: [{ id: "payment", sourceKind: "bank", sourceId: "bank-original" }, { id: "return", sourceKind: "bank", sourceId: "bank-return" }], settlements: [{ kind: "loan", original: { movementId: "payment" }, returns: [{ movementId: "return" }] }], "alfred.native": { tables: { loans: [{ id: "legacy", kind: "lent", bank_message_id: "bank-original", amount: "10.00" }] } } } });
it("blocks exact bank-source overlap between native loan balances and settlement balances", () => {
  expect(nativeLoanOverlapConflicts(archive())).toHaveLength(1);
});
it("also detects a native repayment claiming an explicit settlement return", () => {
  const value = archive(); (value.datasets["alfred.native"] as { tables: { loans: { bank_message_id: string }[] } }).tables.loans[0].bank_message_id = "bank-return";
  expect(nativeLoanOverlapConflicts(value)).toHaveLength(1);
});
it("keeps separate loans even when amounts and person names would match", () => {
  const value = archive(); (value.datasets["alfred.native"] as { tables: { loans: { bank_message_id: string }[] } }).tables.loans[0].bank_message_id = "a-different-source";
  expect(nativeLoanOverlapConflicts(value)).toEqual([]);
  value.datasets.settlements = []; expect(nativeLoanOverlapConflicts(value)).toEqual([]);
});
it("detects exact bank provenance in a Money hop and recognized nested native source", () => {
  const value = archive(); value.manifest.sourceApp = "money-tracker"; value.manifest.namespace = "money-hop";
  value.datasets.movements = [{ id: "payment", sourceKind: "manual", sourceId: "imported-payment", importProvenance: { namespace: "original-alfred", sourceId: "bank:bank-original" } }];
  delete value.datasets["alfred.native"];
  expect(nativeLoanOverlapConflicts(value, [{ namespace: "original-alfred", native: { schema: 1, tables: { loans: [{ id: "legacy", bank_message_id: "bank-original" }] } } }])).toHaveLength(1);
  expect(nativeLoanOverlapConflicts(value, [{ namespace: "a-separate-origin", native: { schema: 1, tables: { loans: [{ id: "legacy", bank_message_id: "bank-original" }] } } }])).toEqual([]);
});
