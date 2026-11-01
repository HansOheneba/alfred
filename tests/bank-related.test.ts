import { describe, expect, it } from "vitest";

import { applyLabel, ingestBankText, labelQuestion, undoLabels, type IngestDeps } from "@/lib/bank/ingest";
import { labelButtons, summarize } from "@/lib/bank/notify";
import { holdFor } from "@/lib/bank/related";
import { MemoryBankStore } from "@/lib/bank/store";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { profile } from "./helpers";

// Absa Ghana wordings, with the names and numbers changed.
const DEBIT = (amount: string, balance: string, time = "18:33") =>
  `GHS ${amount} has been debited to your account ending 4821 as of 11 Oct 2026 ${time}. Your available balance is ${balance} Credit transactions may not yet have cleared`;
const TRANSFER =
  "Dear Customer, Transfer of GHS100 from your account ending 4821 to 233241234567 KOFI MENSAH ADDO on 11/10/26 18:33 was successful. WALLET TxnID 17917435599999";
const SPOTIFY_HOLD =
  "Transaction of GHS 33.00 earmarked on your account ending 4821 as of 11 Oct 2026 17:37 at Spotify_P47E4EAB37_STOCKHOLM_SE. Available balance is GHS 2048.22.";
const MUSIC_HOLD =
  "Transaction of GHS 45.00 earmarked on your account ending 4821 as of 11 Oct 2026 17:37 at SOUNDWAVE_A1B2C3D4E5_ACCRA_GH. Available balance is GHS 2003.22.";

function setup() {
  const bank = new MemoryBankStore();
  const ledger = new MemoryFinanceStore();
  let sequence = 0;
  const deps: IngestDeps = {
    bank,
    ledger,
    now: new Date("2026-10-14T10:00:00.000Z"),
    createId: () => `7a1b2c3d-2222-4222-8222-${String(++sequence).padStart(12, "0")}`,
  };
  const owner = profile(42);
  const send = (text: string) => ingestBankText(deps, owner, text, { channel: "shortcut" });
  return { bank, ledger, deps, owner, send };
}

describe("texts about the same payment", () => {
  it("asks once about an Absa transfer and files its fee, whichever text comes first", async () => {
    const { bank, ledger, send } = setup();
    const debit = await send(DEBIT("100.00", "1,947.22"));
    const fee = await send(DEBIT("1.00", "1,946.22"));
    const transfer = await send(TRANSFER);

    expect(debit.outcomes[0].outcome).toBe("needs_label");
    expect(fee.outcomes[0]).toMatchObject({ outcome: "recorded", category: "Fees" });
    expect(transfer.outcomes[0].outcome).toBe("needs_label");

    const waiting = await bank.listMessages("42", "needs_label");
    expect(waiting.map((item) => [item.amount, item.counterparty])).toEqual([["100.00", "KOFI MENSAH ADDO"]]);
    const rows = await ledger.listTransactions("42");
    expect(rows.map((item) => [item.category, item.amount, item.description, item.paymentMethod])).toEqual([["Fees", "1.00", "Absa fee", "Absa"]]);
  });

  it("matches the bare debit to a transfer that arrived first, and names the fee", async () => {
    const { bank, ledger, send } = setup();
    await send(TRANSFER);
    const debit = await send(DEBIT("100.00", "1,947.22"));
    await send(DEBIT("1.00", "1,946.22"));

    expect(debit.outcomes[0].outcome).toBe("matched");
    expect(summarize(debit.outcomes, "GHS")).toEqual([]);
    expect((await bank.listMessages("42", "needs_label")).map((item) => item.counterparty)).toEqual(["KOFI MENSAH ADDO"]);
    expect((await ledger.listTransactions("42")).map((item) => item.description)).toEqual(["Absa fee · Kofi Mensah Addo"]);
    // The bare debit still reports the account's balance.
    expect(await bank.latestBalances("42")).toEqual([{ source: "absa", balance: "1946.22", at: "2026-10-11T18:33:00.000Z" }]);
  });

  it("turns a GH₵1 debit that came before its payment into that payment's fee", async () => {
    const { ledger, send } = setup();
    const early = await send(DEBIT("1.00", "1,946.22"));
    expect(early.outcomes[0].outcome).toBe("skipped");
    await send(TRANSFER);
    expect((await ledger.listTransactions("42")).map((item) => [item.category, item.amount])).toEqual([["Fees", "1.00"]]);
  });

  it("links a named text to its bare twin when that was already filed", async () => {
    const { deps, owner, bank, send } = setup();
    const debit = await send(DEBIT("100.00", "1,947.22"));
    await applyLabel(deps, owner, debit.outcomes[0].message.id, { kind: "category", category: "People" });
    const transfer = await send(TRANSFER);
    expect(transfer.outcomes[0].outcome).toBe("matched");
    expect(await bank.listMessages("42", "needs_label")).toEqual([]);
  });
});

describe("card payments on hold", () => {
  it("counts a hold at a known merchant straight away", async () => {
    const { ledger, send } = setup();
    const hold = await send(SPOTIFY_HOLD);
    expect(hold.outcomes[0]).toMatchObject({ outcome: "recorded", category: "Subscriptions" });
    expect(hold.outcomes[0].message.kind).toBe("card_hold");
    expect((await ledger.listTransactions("42")).map((item) => [item.description, item.amount, item.transactionDate])).toEqual([["Spotify", "33.00", "2026-10-11"]]);
  });

  it("asks whether a later debit of the same amount is the held payment, and counts it once on yes", async () => {
    const { deps, owner, bank, ledger, send } = setup();
    await send(SPOTIFY_HOLD);
    const later = await send("GHS 33.00 has been debited to your account ending 4821 as of 13 Oct 2026 09:10. Your available balance is 2,015.22");
    const message = later.outcomes[0].message;
    expect(later.outcomes[0].outcome).toBe("needs_label");
    expect(message.kind).toBe("hold_settle");

    const hold = await holdFor(bank, message);
    expect(labelQuestion(message, "Africa/Accra", "", null, hold)).toBe(
      "GH₵33.00 left your Absa account · Tue 13 Oct, 9:10. It matches the Spotify card payment from Sun 11 Oct that was on hold, which I've already counted. Is this the same payment going through?",
    );
    expect(labelButtons(message)[0]).toEqual([{ text: "Yes, same payment", callbackData: `b:${message.id}:s` }]);

    const answered = await applyLabel(deps, owner, message.id, { kind: "skip" });
    expect(answered).toMatchObject({ ok: true, text: "Got it: GH₵33.00 was the Spotify payment going through, so it's only counted once." });
    expect((await ledger.listTransactions("42")).filter((item) => item.status === "active")).toHaveLength(1);
    // Once matched, the hold isn't offered for the next debit.
    const next = await send("GHS 33.00 has been debited to your account ending 4821 as of 14 Oct 2026 09:10. Your available balance is 1,982.22");
    expect(next.outcomes[0].message.kind).toBe("payment");

    if (!answered.ok) throw new Error("label failed");
    await undoLabels(deps, owner, answered.changes);
    expect((await bank.getMessage("42", hold!.id))?.kind).toBe("card_hold");
  });

  it("files the debit normally when the person says it's something else", async () => {
    const { deps, owner, ledger, send } = setup();
    await send(MUSIC_HOLD);
    const later = await send("GHS 45.00 has been debited to your account ending 4821 as of 12 Oct 2026 09:10. Your available balance is 1,958.22");
    expect(later.outcomes[0].message.kind).toBe("hold_settle");
    await applyLabel(deps, owner, later.outcomes[0].message.id, { kind: "category", category: "Food" });
    expect((await ledger.listTransactions("42")).map((item) => item.category).sort()).toEqual(["Food"]);
  });

  it("doesn't ask about a debit when the hold was too long ago", async () => {
    const { send } = setup();
    await send(SPOTIFY_HOLD);
    const later = await send("GHS 33.00 has been debited to your account ending 4821 as of 30 Oct 2026 09:10. Your available balance is 2,015.22");
    expect(later.outcomes[0].message.kind).toBe("payment");
  });
});
