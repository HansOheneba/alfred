import { describe, expect, it } from "vitest";

import { applyLabel, ingestBankText, labelQuestion, type IngestDeps } from "@/lib/bank/ingest";
import { labelButtons } from "@/lib/bank/notify";
import { answerLabelReply } from "@/lib/bank/reply";
import { MemoryBankStore } from "@/lib/bank/store";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { expense, harness, profile, runUpdate } from "./helpers";

const RUKAYA =
  "Payment made for GHS 18.50 to RUKAYA ISSIFU Current Balance: GHS 610.40 . Available Balance: GHS 610.40. Reference: G. Transaction ID: 90806991210. Fee charged: GHS0.38 Tax charged: 0.";
const RUKAYA_AGAIN =
  "Payment made for GHS 12.00 to RUKAYA ISSIFU Current Balance: GHS 598.40 . Available Balance: GHS 598.40. Reference: . Transaction ID: 90806991999. Fee charged: GHS0.00 Tax charged: 0.";
const OWN =
  "Payment received for GHS 500.00 from HANS OHENEBA ADUSE OPOKU Current Balance: GHS 618.03 . Available Balance: GHS 618.03. Reference: HANS OHENEBA ADUSE OPOKU ,GIPS Transfer from GCB Bank. Transaction ID: 90803989481. TRANSACTION FEE: 0.00";
const LOAN = "Payment received for GHS 515.00 from Loan  Account  Current Balance: GHS 629.28 . Available Balance: GHS 629.28. Reference: . Transaction ID: 90804260790.";

function setup() {
  const bank = new MemoryBankStore();
  bank.names = ["Hans Oheneba Aduse Opoku"];
  const ledger = new MemoryFinanceStore();
  let sequence = 0;
  const deps: IngestDeps = {
    bank,
    ledger,
    now: new Date("2026-10-25T10:00:00.000Z"),
    createId: () => `7a1b2c3d-1111-4111-8111-${String(++sequence).padStart(12, "0")}`,
  };
  return { bank, ledger, deps, owner: profile(42) };
}

describe("bank ingest", () => {
  it("holds an unknown payee for a label and logs the fee under Fees", async () => {
    const { deps, ledger, owner } = setup();
    const result = await ingestBankText(deps, owner, RUKAYA, { channel: "shortcut" });
    expect(result.outcomes.map((item) => item.outcome)).toEqual(["needs_label"]);
    const rows = await ledger.listTransactions("42");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category: "Fees", amount: "0.38", paymentMethod: "MoMo" });
  });

  it("learns a payee once labelled and files the next payment on its own", async () => {
    const { deps, ledger, owner } = setup();
    const first = await ingestBankText(deps, owner, RUKAYA, { channel: "shortcut" });
    const labelled = await applyLabel(deps, owner, first.outcomes[0].message.id, { kind: "category", category: "food", description: "Waakye" });
    expect(labelled.text).toBe("Filed GH₵18.50 under Food. I'll file Rukaya Issifu as Food from now on.");

    const second = await ingestBankText(deps, owner, RUKAYA_AGAIN, { channel: "shortcut" });
    expect(second.outcomes[0]).toMatchObject({ outcome: "recorded", category: "Food" });
    const food = (await ledger.listTransactions("42")).filter((item) => item.category === "Food");
    expect(food.map((item) => [item.amount, item.description])).toEqual([
      ["18.50", "Waakye"],
      ["12.00", "Waakye"],
    ]);
  });

  it("fixes the date of a held message when a dated copy arrives", async () => {
    const { deps, bank, owner } = setup();
    await ingestBankText(deps, owner, RUKAYA, { channel: "screenshot" });
    await ingestBankText(deps, owner, `Yesterday 8:15 AM\n${RUKAYA}`, { channel: "screenshot" });
    expect(bank.messages[0].occurredAt).toBe("2026-10-24T08:15:00.000Z");
  });

  it("ignores the same message sent twice", async () => {
    const { deps, owner } = setup();
    await ingestBankText(deps, owner, RUKAYA, { channel: "shortcut" });
    const again = await ingestBankText(deps, owner, RUKAYA, { channel: "screenshot" });
    expect(again).toMatchObject({ found: 1, duplicates: 1, outcomes: [] });
  });

  it("treats own-account transfers and loan deposits as neither income nor spending", async () => {
    const { deps, ledger, owner } = setup();
    const result = await ingestBankText(deps, owner, `${OWN}\n${LOAN}`, { channel: "shortcut" });
    expect(result.outcomes.map((item) => item.outcome)).toEqual(["transfer", "loan"]);
    expect(await ledger.listTransactions("42")).toHaveLength(0);
  });

  it("links a payment to something already logged by hand instead of asking", async () => {
    const { deps, ledger, owner } = setup();
    await ledger.appendTransaction(expense({ transactionDate: "2026-10-25", amount: "18.50", description: "Waakye" }));
    const result = await ingestBankText(deps, owner, RUKAYA, { channel: "shortcut" });
    expect(result.outcomes[0]).toMatchObject({ outcome: "matched", message: { transactionId: "3f2a1c4e-1111-4111-8111-111111111111" } });
  });

  it("offers category buttons, plus 'My own money' for money coming in", async () => {
    const { deps, owner } = setup();
    const out = (await ingestBankText(deps, owner, RUKAYA, { channel: "shortcut" })).outcomes[0].message;
    expect(labelButtons(out).flat().map((button) => button.text)).toEqual(["Food", "Transport", "People", "Personal", "Utilities", "Social", "Subscriptions", "Misc", "Skip"]);
  });

  it("files a typed answer to the open question", async () => {
    const { deps, bank, ledger, owner } = setup();
    const held = (await ingestBankText(deps, owner, RUKAYA, { channel: "shortcut" })).outcomes[0].message;
    await bank.updateMessage("42", held.id, { askedAt: deps.now.toISOString() });
    const reply = await answerLabelReply(deps, owner, "that was transport home", async () => ({ kind: "category", category: "Transport", description: "Ride home" }));
    expect(reply?.text).toContain("under Transport");
    expect((await ledger.listTransactions("42")).some((item) => item.category === "Transport" && item.description === "Ride home")).toBe(true);
    expect(await answerLabelReply(deps, owner, "how much did I spend", async () => null)).toBeNull();
  });
});

describe("payees Alfred already understands", () => {
  const PUSH =
    "Your payment of GHS 30.50 to TELECEL PUSH has been completed at 2026-10-24 20:23:55. Your new balance: GHS 343.94. Fee was GHS 0.38 Tax was GHS -. Reference: -. Financial Transaction Id: 92282961231.";

  it("asks who a cross-network push was to, and never learns the channel as a payee", async () => {
    const { deps, bank, owner } = setup();
    const result = await ingestBankText(deps, owner, PUSH, { channel: "screenshot" });
    const held = result.outcomes[0].message;
    expect(result.outcomes[0]).toMatchObject({ outcome: "needs_label", feeRecorded: true });
    expect(labelQuestion(held, "Africa/Accra")).toContain("to a Telecel Cash number (Telecel Push)");
    expect(labelQuestion(held, "Africa/Accra")).toContain("Who was it to, and what for?");
    const labelled = await applyLabel(deps, owner, held.id, { kind: "category", category: "People", description: "Kofi" });
    expect(labelled.text).toBe("Filed GH₵30.50 under People.");
    expect(bank.rules.size).toBe(0);
  });

  it("files well-known merchants without asking", async () => {
    const { deps, ledger, owner } = setup();
    const ecg = "Your payment of GHS 100.00 to ECG PREPAID has been completed at 2026-10-24 09:00:00. Your new balance: GHS 243.94. Fee was GHS 0.00. Financial Transaction Id: 92282961299.";
    const result = await ingestBankText(deps, owner, ecg, { channel: "shortcut" });
    expect(result.outcomes[0]).toMatchObject({ outcome: "recorded", category: "Utilities" });
    expect((await ledger.listTransactions("42"))[0]).toMatchObject({ category: "Utilities", description: "Electricity" });
  });
});

describe("smarter labelling", () => {
  const FROM_ME =
    "Payment received for GHS 1.00 from HANS OHENEBA ADUSE OPOKU Current Balance: GHS 344.94 . Available Balance: GHS 344.94. Reference: test. Transaction ID: 92300000001. TRANSACTION FEE: 0.00";
  const FROM_ME_AGAIN =
    "Payment received for GHS 2.00 from HANS OHENEBA ADUSE OPOKU Current Balance: GHS 346.94 . Available Balance: GHS 346.94. Reference: test. Transaction ID: 92300000002. TRANSACTION FEE: 0.00";

  it("asks whether money from someone with your name is your own, then learns the name", async () => {
    const { deps, bank, owner } = setup();
    bank.names = [];
    const me = { ...owner, preferredName: "Hans" };
    const held = (await ingestBankText(deps, me, FROM_ME, { channel: "shortcut" })).outcomes[0].message;
    expect(labelQuestion(held, "Africa/Accra", "Hans")).toContain("That looks like you. Was it your own money");
    expect(labelButtons(held, "Hans")[0].map((button) => button.text)).toEqual(["My own money"]);

    const done = await applyLabel(deps, me, held.id, { kind: "transfer" });
    expect(done.text).toContain("I'll treat Hans Oheneba Aduse Opoku as you from now on.");
    const next = await ingestBankText(deps, me, FROM_ME_AGAIN, { channel: "shortcut" });
    expect(next.outcomes[0].outcome).toBe("transfer");
  });

  it("never learns a payee from a vague label or from your own name", async () => {
    const { deps, bank, owner } = setup();
    const held = (await ingestBankText(deps, owner, RUKAYA, { channel: "shortcut" })).outcomes[0].message;
    await applyLabel(deps, owner, held.id, { kind: "category", category: "Misc" });
    expect(bank.rules.size).toBe(0);
  });

  const AMOS =
    "Payment made for GHS 31.50 to AMOS SEKYI SAM Current Balance: GHS 374.82 . Available Balance: GHS 374.82. Reference: . Transaction ID: 92243526792. Fee charged: GHS0.00";

  it("answers 'what are those' with the next waiting payment, and moves on after each answer", async () => {
    const { deps, owner } = setup();
    await ingestBankText(deps, owner, `Sun, 4 Oct at 8:15 AM\n${RUKAYA}\nMon, 5 Oct at 9:00 AM\n${AMOS}`, { channel: "screenshot" });
    const listed = await answerLabelReply(deps, owner, "What are those", async () => null);
    expect(listed?.text).toContain("2 payments are waiting for a label.");
    expect(listed?.next?.counterparty).toBe("RUKAYA ISSIFU");

    const answered = await answerLabelReply(deps, owner, "food", async () => ({ kind: "category", category: "Food" }));
    expect(answered?.text).toContain("Next: GH₵31.50 to Amos Sekyi Sam");
    expect(answered?.text).not.toContain("above");
  });

  it("files other waiting payments to a payee once it's learned", async () => {
    const { deps, bank, owner } = setup();
    const result = await ingestBankText(deps, owner, `${RUKAYA}\n${RUKAYA_AGAIN}`, { channel: "screenshot" });
    const done = await applyLabel(deps, owner, result.outcomes[0].message.id, { kind: "category", category: "Food" });
    expect(done.text).toContain("I've also filed 1 other payment to Rukaya Issifu the same way.");
    expect(await bank.listMessages("42", "needs_label")).toHaveLength(0);
  });
});

describe("telegram label buttons", () => {
  it("records the tapped category and edits the question", async () => {
    const bank = new MemoryBankStore();
    const { deps, store, telegram } = harness({ bank });
    const ingestDeps = { bank, ledger: store, now: deps.now(), createId: deps.createId };
    const held = (await ingestBankText(ingestDeps, profile(42), RUKAYA, { channel: "shortcut" })).outcomes[0].message;
    await runUpdate(
      {
        update_id: 900,
        callback_query: { id: "cb-label", from: { id: 42 }, data: `b:${held.id}:c0`, message: { message_id: 77, chat: { id: 100, type: "private" } } },
      },
      deps,
    );
    expect((await store.listTransactions("42")).some((item) => item.category === "Food" && item.amount === "18.50")).toBe(true);
    expect(telegram.edits.at(-1)?.text).toContain("✓ Filed GH₵18.50 under Food.");
  });

  it("reads a screenshot sent to the bot and replies with what it filed", async () => {
    const { deps, telegram } = harness({
      readPhoto: async () => ({ text: RUKAYA, kind: "bank_sms", engine: "deepseek" }),
      bankScreenshot: async (_owner, image) => `Read: ${image.text.slice(0, 20)}`,
    });
    await runUpdate(
      {
        update_id: 950,
        message: { message_id: 5, chat: { id: 100, type: "private" }, from: { id: 42 }, photo: [{ file_id: "small", width: 90 }, { file_id: "big", width: 1280 }] },
      },
      deps,
    );
    expect(telegram.sent.at(-1)?.text).toBe("Read: Payment made for GHS");
  });
});
