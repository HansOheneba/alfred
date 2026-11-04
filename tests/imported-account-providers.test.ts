import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseSettings } from "@/lib/config";
const transport = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: transport.query }));
import { importedTransferCandidates, loadImportedTransferProviders, IMPORTED_TRANSFER_PROVIDERS_SQL } from "@/lib/bank/imported-account-providers";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const settings = { host: "synthetic.invalid", projectRef: "synthetic", user: "fixture", database: "fixture", password: "" } as unknown as SupabaseSettings;
const namespace = "money-site:synthetic-provider-fixture", at = "2026-11-04T11:00:00Z";
const account = (id = "imported-hubtel", sourceId = "hubtel-wallet") => ({ id, label: "Arbitrary user alias", provider: "Imported Money Tracker", currency: "GHS", includeInCash: true, createdAt: at, importProvenance: { namespace, sourceId } });
const archive = (sourceId = "hubtel-wallet") => ({ manifest: { sourceApp: "money-tracker", namespace, currency: "GHS" }, datasets: { accounts: [{ id: sourceId, label: "Different original label", provider: "Imported Money Tracker", currency: "GHS", includeInCash: true }], "moneyTracker.native": { snapshot: { currency: "GHS", accounts: [{ account: sourceId, label: "Also ignored", cash: true }] } } } });
let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec("create table finance_import_receipts(owner_id uuid,id text,after_state jsonb,archive jsonb,undone_at timestamptz,primary key(owner_id,id))");
  transport.query.mockImplementation(async (_settings, sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows);
});
beforeEach(async () => { await db.exec("truncate finance_import_receipts"); transport.query.mockClear(); });
afterAll(async () => { await db.close(); });
async function receipt(options: { owner?: string; saved?: unknown[]; source?: unknown; undone?: string | null; id?: string } = {}) {
  await db.query("insert into finance_import_receipts values($1,$2,$3::jsonb,$4::jsonb,$5)", [options.owner ?? OWNER, options.id ?? "synthetic-receipt", JSON.stringify({ accounts: options.saved ?? [account()] }), JSON.stringify(options.source ?? archive()), options.undone ?? null]);
}

describe("corroborated imported Money account provider facts", () => {
  it("does not infer from a label, an unknown origin key, a disabled cash account, a foreign currency or an explicit provider", async () => {
    const noOrigin = { ...account(), label: "Hubtel wallet", importProvenance: undefined };
    const inputs = [noOrigin, { ...account(), provider: "GCB" }, { ...account(), includeInCash: false }, { ...account(), currency: "USD" }, account("unknown", "someone-named-hubtel")];
    expect(importedTransferCandidates(inputs)).toEqual([]);
    expect(await loadImportedTransferProviders(settings, OWNER, inputs)).toEqual(new Map());
    expect(transport.query).not.toHaveBeenCalled();
  });

  it("requires a real owned corroborating receipt even for a known namespace/source key", async () => {
    expect(await loadImportedTransferProviders(settings, OWNER, [account()])).toEqual(new Map());
    await receipt();
    const before = JSON.stringify(account());
    expect(await loadImportedTransferProviders(settings, OWNER, [account()])).toEqual(new Map([["imported-hubtel", "hubtel"]]));
    expect(JSON.stringify(account())).toBe(before);
  });

  it("recognises MTN by its original key with arbitrary labels, and supports a documented retained archive wrapper", async () => {
    const momo = account("imported-momo", "mtn-momo");
    await receipt({ saved: [momo], source: { manifest: { sourceApp: "alfred" }, datasets: { "alfred.native": { retainedArchives: [{ archiveId: "fictional", archive: archive("mtn-momo") }] } } } });
    expect(await loadImportedTransferProviders(settings, OWNER, [{ ...momo, label: "Not a bank name" }])).toEqual(new Map([["imported-momo", "momo"]]));
  });

  it.each(["owner", "undone", "after-id", "after-origin", "source-app", "namespace", "currency", "core-cash", "core-provider", "native-key", "native-cash", "native-currency", "malformed"])("fails closed for %s proof", async (failure) => {
    const source = archive(), saved: Record<string, unknown>[] = [account()];
    if (failure === "after-id") saved[0].id = "another-account";
    if (failure === "after-origin") saved[0].importProvenance = { namespace, sourceId: "mtn-momo" };
    if (failure === "source-app") source.manifest.sourceApp = "another-app";
    if (failure === "namespace") source.manifest.namespace = "money-site:other-origin";
    if (failure === "currency") source.datasets.accounts[0].currency = "USD";
    if (failure === "core-cash") source.datasets.accounts[0].includeInCash = false;
    if (failure === "core-provider") source.datasets.accounts[0].provider = "Explicit different provider";
    if (failure === "native-key") source.datasets["moneyTracker.native"].snapshot.accounts[0].account = "mtn-momo";
    if (failure === "native-cash") source.datasets["moneyTracker.native"].snapshot.accounts[0].cash = false;
    if (failure === "native-currency") source.datasets["moneyTracker.native"].snapshot.currency = "USD";
    await receipt({ owner: failure === "owner" ? OTHER : OWNER, undone: failure === "undone" ? at : null, saved, source: failure === "malformed" ? { manifest: source.manifest, datasets: { accounts: null, "moneyTracker.native": { snapshot: { accounts: 1 } } } } : source });
    expect(await loadImportedTransferProviders(settings, OWNER, [account()])).toEqual(new Map());
  });

  it("respects current provider/currency/cash/provenance edits instead of reviving old imported identity", async () => {
    await receipt();
    for (const changed of [{ ...account(), provider: "My explicit bank" }, { ...account(), currency: "USD" }, { ...account(), includeInCash: false }, { ...account(), importProvenance: { namespace: "other", sourceId: "hubtel-wallet" } }]) expect(await loadImportedTransferProviders(settings, OWNER, [changed])).toEqual(new Map());
  });

  it("projects only provider facts and share-locks proofs without waiting behind an import undo", () => {
    expect(IMPORTED_TRANSFER_PROVIDERS_SQL).toContain("receipt.owner_id=$1::uuid");
    expect(IMPORTED_TRANSFER_PROVIDERS_SQL).toContain("receipt.undone_at is null");
    expect(IMPORTED_TRANSFER_PROVIDERS_SQL).toContain("for share of receipt skip locked");
    expect(IMPORTED_TRANSFER_PROVIDERS_SQL).not.toMatch(/select\s+(?:receipt\.archive|\*)\s*(?:,|from)/i);
  });
});
