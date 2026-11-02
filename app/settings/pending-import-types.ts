import type { ImportPreview } from "@/app/settings/portability-section";

export type PendingImportDomain = {
  dataset: string;
  status: "awaiting_support" | "review_required" | "source_evidence";
  reason: string;
  count: number | null;
  path?: string[];
};

export type PendingImportItem = {
  receiptId: string;
  archiveId: string;
  sourceApp: string;
  namespace: string;
  exportedAt: string;
  importedAt: string;
  undone: boolean;
  activeCounts: { accounting: Record<string, number>; native: Record<string, number> };
  pendingDomains: PendingImportDomain[];
  savedDatasetCounts: Record<string, number>;
  activationAvailable: boolean;
};

export type PendingImportDetail = {
  item: PendingImportItem;
  manifest: Record<string, unknown>;
  datasets: Record<string, unknown>;
  redactions: string[];
};

export type PendingActivationPreview =
  | { status: "ready"; preview: ImportPreview }
  | { status: "nothing_new" | "blocked"; text: string; conflicts?: string[]; pendingDomains?: PendingImportDomain[] };

export type PendingImportTransport = {
  pending: () => Promise<PendingImportItem[]>;
  pendingPage?: (cursor?: string) => Promise<{ items: PendingImportItem[]; nextCursor: string | null }>;
  pendingDetail: (receiptId: string) => Promise<PendingImportDetail>;
  downloadPending: (receiptId: string) => Promise<Blob>;
  previewActivation: (receiptId: string) => Promise<PendingActivationPreview>;
};
