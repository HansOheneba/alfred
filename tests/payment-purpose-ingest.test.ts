import { afterEach, describe, expect, it, vi } from "vitest";

import { ingestBankText, type IngestDeps } from "@/lib/bank/ingest";
import { incomingPaymentMention } from "@/lib/bank/notices";
import { payeeKey } from "@/lib/bank/parse";
import { MemoryBankStore, type BankMessage } from "@/lib/bank/store";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import * as notificationStore from "@/lib/notifications/store";
import { profile } from "./helpers";

const PERSON = "FIXTURE PERSON";
const RECEIVED =
  "Payment received for GHS 125.00 from FIXTURE PERSON Current Balance: GHS 500.00 . Available Balance: GHS 500.00. Reference: . Transaction ID: 99000125001. TRANSACTION FEE: 0.00";
const SENT =
  "Payment made for GHS 25.00 to FIXTURE PERSON Current Balance: GHS 475.00 . Available Balance: GHS 475.00. Reference: . Transaction ID: 99000125002. Fee charged: GHS0.00 Tax charged: 0.";

function setup() {
  const bank = new MemoryBankStore();
  const ledger = new MemoryFinanceStore();
  let sequence = 0;
  const deps: IngestDeps = {
    bank,
    ledger,
    now: new Date("2026-11-03T10:00:00.000Z"),
    createId: () => `9a1b2c3d-1111-4111-8111-${String(++sequence).padStart(12, "0")}`,
  };
  return { bank, ledger, deps, owner: profile(42) };
}

afterEach(() => vi.restoreAllMocks());

const channels: BankMessage["channel"][] = ["mac", "shortcut", "manual", "screenshot"];
const savedChoices = [
  ["Other", ""],
  ["Other", "Other"],
  ["Other", "From Fixture Person"],
  ["Other", "Payment received"],
  ["Misc", ""],
] as const;

describe("saved income choices remain independent of optional automation", () => {
  it.each(channels.flatMap(channel => savedChoices.map(([category, description]) => ({ channel, category, description }))))(
    "honors saved $category / $description on $channel with automation off and no preference reads",
    async ({ channel, category, description }) => {
      const { bank, ledger, deps, owner } = setup();
      expect(notificationStore.DEFAULT_NOTIFICATION_PREFERENCES).toMatchObject({ paymentMentions: false, paymentPush: false });
      const preferenceRead = vi.spyOn(notificationStore, "loadNotificationPreferences").mockRejectedValue(new Error("Ingestion must not depend on optional notification preferences"));
      await bank.saveRule(owner.profileId, { payeeKey: payeeKey(PERSON), category, description });

      const result = await ingestBankText(deps, owner, RECEIVED, { channel, sender: "MobileMoney" });

      expect(result.outcomes).toHaveLength(1);
      expect(result.outcomes[0]).toMatchObject({ outcome: "recorded", category: "Other", message: { status: "recorded", readBy: "rules" } });
      expect(result.outcomes[0].message.transactionId).toBeTruthy();
      expect(result.durableMessageIds).toEqual([result.outcomes[0].message.id]);
      expect(await ledger.listTransactions(owner.profileId)).toMatchObject([
        { type: "income", category: "Other", description: description || "From Fixture Person", amount: "125.00" },
      ]);
      expect(await bank.getRule(owner.profileId, payeeKey(PERSON))).toMatchObject({ category, description });
      expect(preferenceRead).not.toHaveBeenCalled();
    },
  );

  it("offers a Review correction for a generic saved category without undoing it or recording twice", async () => {
    const { bank, ledger, deps, owner } = setup();
    await bank.saveRule(owner.profileId, { payeeKey: payeeKey(PERSON), category: "Other", description: "" });
    const result = await ingestBankText(deps, owner, RECEIVED, { channel: "mac", sender: "MobileMoney" });
    const transaction = (await ledger.listTransactions(owner.profileId))[0];

    const mention = incomingPaymentMention({
      ...result.outcomes[0].message,
      createdAt: deps.now.toISOString(),
      purpose: { ownerId: owner.profileId, transactionId: transaction.transactionId, category: transaction.category, description: transaction.description, recordStatus: transaction.status },
    });

    expect(mention?.body).toContain("What was this for?");
    expect(mention?.body).toContain("Review");
    expect(mention?.body).not.toContain("filed it under Other");
    expect(mention?.requiresPurpose).toBe(false);
    expect(result.outcomes[0].message.status).toBe("recorded");
    expect(await ledger.listTransactions(owner.profileId)).toHaveLength(1);
  });

  it("keeps durable event identity on duplicate ingestion without duplicating the saved income", async () => {
    const { bank, ledger, deps, owner } = setup();
    await bank.saveRule(owner.profileId, { payeeKey: payeeKey(PERSON), category: "Other", description: "" });
    const first = await ingestBankText(deps, owner, RECEIVED, { channel: "shortcut", sender: "MobileMoney" });
    const again = await ingestBankText(deps, owner, RECEIVED, { channel: "shortcut", sender: "MobileMoney" });
    expect(again).toMatchObject({ duplicates: 1, outcomes: [] });
    expect(again.durableMessageIds).toEqual(first.durableMessageIds);
    expect(await ledger.listTransactions(owner.profileId)).toHaveLength(1);
  });

  it("preserves a specific saved description under Other", async () => {
    const { bank, ledger, deps, owner } = setup();
    await bank.saveRule(owner.profileId, { payeeKey: payeeKey(PERSON), category: "Other", description: "November club dues" });
    const result = await ingestBankText(deps, owner, RECEIVED, { channel: "mac", sender: "MobileMoney" });
    expect(result.outcomes[0]).toMatchObject({ outcome: "recorded", category: "Other" });
    expect(await ledger.listTransactions(owner.profileId)).toMatchObject([{ type: "income", category: "Other", description: "November club dues", amount: "125.00" }]);
  });

  it("preserves fee and principal recording from an explicit saved income rule", async () => {
    const { bank, ledger, deps, owner } = setup();
    await bank.saveRule(owner.profileId, { payeeKey: payeeKey("Hubtel wallet"), category: "Other", description: "" });
    const deposit = "GHS 125.00 was deposited into your Hubtel wallet. Reference: fixture. Transaction ID: 99000125003. Fee charged: GHS0.50.";
    const result = await ingestBankText(deps, owner, deposit, { channel: "mac", sender: "Hubtel" });
    expect(result.outcomes[0]).toMatchObject({ outcome: "recorded", category: "Other", feeRecorded: true });
    const transactions = await ledger.listTransactions(owner.profileId);
    expect(transactions).toHaveLength(2);
    expect(transactions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "expense", category: "Fees", amount: "0.50" }),
      expect.objectContaining({ type: "income", category: "Other", amount: "125.00" }),
    ]));
  });

  it("preserves a meaningful category such as Salary with an empty saved description", async () => {
    const { bank, ledger, deps, owner } = setup();
    await bank.saveRule(owner.profileId, { payeeKey: payeeKey(PERSON), category: "Salary", description: "" });
    const result = await ingestBankText(deps, owner, RECEIVED, { channel: "mac", sender: "MobileMoney" });
    expect(result.outcomes[0]).toMatchObject({ outcome: "recorded", category: "Salary" });
    expect(await ledger.listTransactions(owner.profileId)).toMatchObject([{ type: "income", category: "Salary", description: "From Fixture Person" }]);
  });

  it("still leaves a recognized provider's payment unlabelled when no rule or purpose is saved", async () => {
    const { ledger, deps, owner } = setup();
    const result = await ingestBankText(deps, owner, RECEIVED, { channel: "mac", sender: "MobileMoney" });
    expect(result.outcomes[0]).toMatchObject({ outcome: "needs_label", message: { readBy: "rules", transactionId: null } });
    expect(await ledger.listTransactions(owner.profileId)).toHaveLength(0);
  });

  it("preserves outgoing learned-category behavior", async () => {
    const { bank, ledger, deps, owner } = setup();
    await bank.saveRule(owner.profileId, { payeeKey: payeeKey(PERSON), category: "Misc", description: "" });
    const result = await ingestBankText(deps, owner, SENT, { channel: "mac", sender: "MobileMoney" });
    expect(result.outcomes[0]).toMatchObject({ outcome: "recorded", category: "Misc" });
    expect(await ledger.listTransactions(owner.profileId)).toMatchObject([{ type: "expense", category: "Misc", amount: "25.00" }]);
  });
});
