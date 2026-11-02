import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseSettings } from "@/lib/config";
const mocks=vi.hoisted(()=>({query:vi.fn()}));
vi.mock("@/lib/supabase/connection",()=>({query:mocks.query}));
import { ACCOUNT_RULES_READY_SQL, PORTABILITY_READY_SQL } from "@/lib/supabase/finance-capabilities";
import { loadAccountRules, saveAccountRuleCommand } from "@/lib/account-rules/store";
import { exportFinanceArchive, PortabilityUnavailable, requirePortability } from "@/lib/portability/service";
const settings={} as SupabaseSettings;
const owner="00000000-0000-4000-8000-000000000001";
beforeEach(()=>mocks.query.mockReset());
describe("finance capability barriers",()=>{
  it("keeps account rules unavailable without reading state when the versioned ABI is missing",async()=>{
    mocks.query.mockResolvedValue([{ready:false}]);
    expect(await loadAccountRules(settings,owner)).toEqual({availability:"migration-required",state:{ownerId:owner,revision:0,rules:[],bindings:[]}});
    expect(mocks.query).toHaveBeenCalledExactlyOnceWith(settings,ACCOUNT_RULES_READY_SQL);
  });
  it("refuses rule writes before state or account queries on an earlier draft",async()=>{
    mocks.query.mockResolvedValue([{ready:false}]);
    const result=await saveAccountRuleCommand(settings,owner,{type:"delete_rule",ruleId:"00000000-0000-4000-8000-000000000010",expectedRevision:0,requestId:"synthetic-unavailable"});
    expect(result.availability).toBe("migration-required");
    expect(mocks.query).toHaveBeenCalledExactlyOnceWith(settings,ACCOUNT_RULES_READY_SQL);
  });
  it("blocks portability before any archive or financial data query on an earlier draft",async()=>{
    mocks.query.mockResolvedValue([{ready:false}]);
    await expect(exportFinanceArchive(settings,owner)).rejects.toBeInstanceOf(PortabilityUnavailable);
    expect(mocks.query).toHaveBeenCalledExactlyOnceWith(settings,PORTABILITY_READY_SQL);
  });
  it("accepts only an explicitly positive capability result",async()=>{
    mocks.query.mockResolvedValue([]);
    await expect(requirePortability(settings)).rejects.toBeInstanceOf(PortabilityUnavailable);
    mocks.query.mockResolvedValue([{ready:true}]);
    await expect(requirePortability(settings)).resolves.toBeUndefined();
  });
});

// Published migration filenames are ledger identities. Review fixes belong in a forward file.
it("keeps the already-published migrations byte-for-byte unchanged", async () => {
  const expected = {
    "20261102170000_account_rules.sql": "ae0b81c1a81e4b25f288853a8de6ced148f9b46912261b8455d481bf6c57ef26",
    "20261102180000_data_portability.sql": "360dc8597275b618de29552065494d3c13df6d12099ae0482713d1ea3c343bb2",
  };
  for (const [name, digest] of Object.entries(expected)) {
    const bytes = await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest);
  }
});
