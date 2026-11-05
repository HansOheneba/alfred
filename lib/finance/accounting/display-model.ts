import type { LedgerRow } from "../analytics";
import type { AccountsModelManifest } from "./accounts-model";

export const ACCOUNTING_DISPLAY_DEFINITION = "accounting-display-v1";
export const ACCOUNTING_DISPLAY_VERSION = 1;
// Publication is a complete generation. Oversized inputs must remain unavailable;
// a partial financial model must never be made readable as a complete ledger.
export const ACCOUNTING_DISPLAY_LIMITS = { maxRows: 400_000, maxBytes: 64 * 1024 * 1024, maxManifestBytes: 2 * 1024 * 1024, maxRowBytes: 2 * 1024 * 1024 } as const;
export type DurableModelRowKind = "movement" | "snapshot" | "transfer" | "settlement" | "return" | "evidence" | "ledger";
export type DurableModelRow = {
  id: string; kind: DurableModelRowKind; ordinal: number;
  accountId?: string | null; date?: string | null; currency?: string | null; category?: string | null;
  direction?: string | null; status?: string | null; amountMinor?: number | null; searchText: string;
  rankDateAsc?: number | null; rankDateDesc?: number | null; rankAmountAsc?: number | null; rankAmountDesc?: number | null;
  needsAttention?: boolean; groupKey?: string | null; relationId?: string | null;
  payload: unknown;
};
export type DurableLedgerPayload = LedgerRow & { transactionOrdinal: number; descriptionKey: string; descriptionLabel: string; descriptionSearch: string; categorySearch: string; paymentLabel: string; merchantKey:string;merchantLabelRank:number;renewalGroup?: { id: string; name: string; nameKey: string } | null };
export type DurableLedgerManifest = { count: number; earliestDate: string | null; currencies: string[] };
export type AccountingDisplayManifest = {
  kind: "accounting-display"; projectorVersion: typeof ACCOUNTING_DISPLAY_VERSION;
  ownerId: string; revision: number; sourceVersion: string | null;
  accounts: AccountsModelManifest; ledger: DurableLedgerManifest; rowCounts: Record<DurableModelRowKind, number>;
};
export type AccountingDisplayModel = { definition: typeof ACCOUNTING_DISPLAY_DEFINITION; manifest: AccountingDisplayManifest; rows: DurableModelRow[] };

