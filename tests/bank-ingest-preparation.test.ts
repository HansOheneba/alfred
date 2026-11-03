import { describe, expect, it, vi } from "vitest";
import { ingestPreparedBankText, prepareBankText, type IngestDeps } from "@/lib/bank/ingest";
import { MemoryBankStore } from "@/lib/bank/store";
import { parseBankText } from "@/lib/bank/parse";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import type { UserProfile } from "@/lib/config";

const now = new Date("2026-11-03T22:00:00Z");
const owner: UserProfile = { profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", telegramUserId: null, spreadsheetId: "", currency: "GHS", timezone: "Africa/Accra", preferredName: "Fictional", communicationPreference: "concise" };
const text = "Payment received for GHS 2.00 from FICTIONAL PERSON Current Balance: GHS 102.00 . Available Balance: GHS 102.00. Reference: synthetic. Transaction ID: 92300000003. TRANSACTION FEE: 0.00";

function dependencies() {
  const bank = new MemoryBankStore(), ledger = new MemoryFinanceStore();
  const names = vi.spyOn(bank, "accountNames"), ignored = vi.spyOn(bank, "ignoredAccounts");
  const insert = vi.spyOn(bank, "insertMessage");
  const deps: IngestDeps = { bank, ledger, now, createId: () => "22222222-2222-4222-8222-222222222222" };
  return { deps, bank, ledger, names, ignored, insert };
}

describe("bank parsing finishes before transactional disposition", () => {
  it("allows the external reader to finish before any bank read/write, and never calls it during disposition", async () => {
    const { deps, names, ignored, insert, ledger } = dependencies();
    const parsed = parseBankText(text, { now, timeZone: owner.timezone, sender: "MobileMoney" });
    const reader = vi.fn(async () => {
      expect(names).not.toHaveBeenCalled(); expect(ignored).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled();
      return parsed;
    });
    deps.readUnknown = reader;
    const options = { channel: "mac" as const, sender: "FictionalBank", receivedAt: now };
    const prepared = await prepareBankText(deps, owner, "Your FictionalBank account received GHS 2.00. Balance GHS 102.00.", options);
    expect(prepared).toMatchObject({ readBy: "model", parsed });
    expect(reader).toHaveBeenCalledOnce(); expect(insert).not.toHaveBeenCalled();
    const result = await ingestPreparedBankText(deps, owner, prepared, options);
    expect(result.outcomes[0].message).toMatchObject({ status: "needs_label", readBy: "model", amount: "2.00" });
    expect(reader).toHaveBeenCalledOnce(); expect(insert).toHaveBeenCalledOnce();
    expect(await ledger.listTransactions(owner.profileId)).toEqual([]);
  });

  it("makes a reader failure retryable before any source evidence or ledger write", async () => {
    const { deps, bank, ledger, names, ignored } = dependencies();
    deps.readUnknown = vi.fn(async () => { throw new Error("Synthetic unavailable reader"); });
    await expect(prepareBankText(deps, owner, "Your FictionalBank account received GHS 2.00. Balance GHS 102.00.", { channel: "mac", sender: "FictionalBank" }))
      .rejects.toThrow("Synthetic unavailable reader");
    expect(names).not.toHaveBeenCalled(); expect(ignored).not.toHaveBeenCalled();
    expect(bank.messages).toEqual([]); expect(await ledger.listTransactions(owner.profileId)).toEqual([]);
  });

  it("retains deterministic known-provider parsing without an external reader", async () => {
    const { deps, insert } = dependencies();
    deps.readUnknown = vi.fn();
    const prepared = await prepareBankText(deps, owner, text, { channel: "mac", sender: "MobileMoney" });
    expect(prepared.readBy).toBe("rules"); expect(prepared.parsed).toHaveLength(1);
    expect(deps.readUnknown).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled();
  });
});
