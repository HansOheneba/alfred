export const MAX_ARCHIVE_BYTES: number;
export const MAX_RECORDS: number;
export type Coverage = {
  dataset: string;
  status: 'supported' | 'preserved' | 'excluded' | 'unavailable';
  reason: string;
  count?: number;
};
export type Datasets = {
  accounts: unknown[];
  movements: unknown[];
  snapshots: unknown[];
  transfers: unknown[];
  settlements: unknown[];
  [name: string]: unknown[] | Record<string, unknown>;
};
export type Manifest = {
  format: 'finance-portability';
  version: 1;
  sourceApp: 'money-tracker' | 'alfred';
  namespace: string;
  exportedAt: string;
  timezone: string;
  currency: string;
  counts: Record<string, number>;
  checksums: Record<string, string>;
  coverage: Coverage[];
};
export type Archive = { manifest: Manifest; datasets: Datasets; archiveId: string };
export function canonicalStringify(value: unknown): string;
export function hashValue(value: unknown): Promise<string>;
export function validateDatasets(datasets: unknown): Datasets;
export function createArchive(input: {
  sourceApp: Manifest['sourceApp'];
  namespace: string;
  timezone: string;
  currency: string;
  datasets: Datasets;
  coverage: Coverage[];
  exportedAt?: string;
}): Promise<Uint8Array>;
export function readArchive(bytes: Uint8Array | ArrayBuffer): Promise<Archive>;
