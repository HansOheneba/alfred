import { describe, expect, it } from "vitest";

import { applyLabel, ingestBankText, type IngestDeps } from "@/lib/bank/ingest";
import { labelButtons, questionFor } from "@/lib/bank/notify";
import { buildSystemPrompt } from "@/lib/ai/prompts";
import { answerLabelReply, resolvedFrom, waitingPayments, type LabelResolver } from "@/lib/bank/reply";
import { MemoryBankStore } from "@/lib/bank/store";
import { executeConfirmed, handleAction, type ActionContext } from "@/lib/finance/action-router";
import { findPerson, loanBalances, MemoryLoanStore } from "@/lib/finance/loans";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { parseModelOutput, pendingPayloadSchema } from "@/lib/finance/schemas";
import { profile } from "./helpers";

const DEBORAH =
  "Payment made for GHS 400.00 to DEBORAH AMA ZENABA KONADU Current Balance: GHS 210.00 . Available Balance: GHS 210.00. Reference: . Transaction ID: 92400000001. Fee charged: GHS3.00";
const DEBORAH_BACK =
  "Payment received for GHS 150.00 from DEBORAH AMA ZENABA KONADU Current Balance: GHS 360.00 . Available Balance: GHS 360.00. Reference: . Transaction ID: 92400000002. TRANSACTION FEE: 0.00";
const ADISAH =
  "Payment made for GHS 10.50 to ADISAH ANABZO Current Balance: GHS 199.50 . Available Balance: GHS 199.50. Reference: . Transaction ID: 92400000003. Fee charged: GHS0.00";
const ADISAH_AGAIN =
  "Payment made for GHS 12.00 to ADISAH ANABZO Current Balance: GHS 187.50 . Available Balance: GHS 187.50. Reference: . Transaction ID: 92400000004. Fee charged: GHS0.00";
const GODWIN =
  "Payment made for GHS 61.50 to GODWIN ABAYA Current Balance: GHS 126.00 . Available Balance: GHS 126.00. Reference: . Transaction ID: 92400000005. Fee charged: GHS0.46";

function setup() {
  const bank = new MemoryBankStore();
  const ledger = new MemoryFinanceStore();
  const loans = new MemoryLoanStore();
  let sequence = 0;
  const deps: IngestDeps = {
    bank,
    ledger,
    loans,
    now: new Date("2026-10-29T10:00:00.000Z"),
    createId: () => `7a1b2c3d-2222-4222-8222-${String(++sequence).padStart(12, "0")}`,
  };
  return { bank, ledger, loans, deps, owner: profile(42, { preferredName: "Hans" }) };
}

async function held(deps: IngestDeps, owner: ReturnType<typeof profile>, text: string) {
  return (await ingestBankText(deps, owner, text, { channel: "mac" })).outcomes[0].message;
}

describe("loan balances", () => {
  it("adds up what each person still owes and matches nicknames", async () => {
    const loans = new MemoryLoanStore();
    const base = { currency: "GHS", note: "", bankMessageId: null };
    await loans.add("42", { ...base, person: "Deborah Ama Zenaba Konadu", kind: "lent", amount: "400.00", occurredAt: "2026-10-28T11:44:00.000Z" });
    await loans.add("42", { ...base, person: "Deborah Ama Zenaba Konadu", kind: "repaid", amount: "150.00", occurredAt: "2026-10-29T09:00:00.000Z" });
    await loans.add("42", { ...base, person: "Kofi", kind: "lent", amount: "100.00", occurredAt: "2026-10-20T09:00:00.000Z" });
    const balances = loanBalances(await loans.list("42"));
    expect(balances.map((item) => [item.person, item.owed])).toEqual([
      ["Deborah Ama Zenaba Konadu", "250.00"],
      ["Kofi", "100.00"],
    ]);
    expect(findPerson(balances, "Debby")?.person).toBe("Deborah Ama Zenaba Konadu");
    expect(findPerson(balances, "deborah")?.person).toBe("Deborah Ama Zenaba Konadu");
    expect(findPerson(balances, "Ama")).toBeNull();
  });
});

describe("names in a reply", () => {
  it("doesn't take Samuel to mean Amos Sekyi Sam", async () => {
    const { deps, bank, owner } = setup();
    const amos = await held(deps, owner, "Payment made for GHS 31.50 to AMOS SEKYI SAM Current Balance: GHS 374.82 . Available Balance: GHS 374.82. Reference: . Transaction ID: 92400000020. Fee charged: GHS0.00");
    await applyLabel(deps, owner, amos.id, { kind: "category", category: "Transport" });
    const samuel = await held(deps, owner, "Payment made for GHS 8.00 to SAMUEL MPENIASAH Current Balance: GHS 366.82 . Available Balance: GHS 366.82. Reference: . Transaction ID: 92400000021. Fee charged: GHS0.00");
    await held(deps, owner, GODWIN);
    const reply = await answerLabelReply(deps, owner, "Samuel was office snacks", async () => [
      { messageIds: [samuel.id], label: { kind: "category", category: "Food", description: "Office snacks" } },
    ]);
    expect(reply?.text).toContain("I'll file Samuel Mpeniasah as Food");
    expect(reply?.text).not.toContain("Amos");
    expect(bank.rules.get("amos sekyi sam")?.category).toBe("Transport");
  });
});

describe("lending through bank labels", () => {
  it("records money lent without counting it as spending, then asks if money back is a repayment", async () => {
    const { deps, ledger, owner } = setup();
    const out = await held(deps, owner, DEBORAH);
    expect(labelButtons(out, "Hans", { lending: true }).flat().map((button) => button.text)).toContain("I lent it");

    const lent = await applyLabel(deps, owner, out.id, { kind: "lent" });
    expect(lent.text).toBe("Noted: you lent Deborah Ama Zenaba Konadu GH₵400.00. It isn't counted as spending. Deborah Ama Zenaba Konadu owes you GH₵400.00 in total.");
    // Only the GH₵3 fee reaches the books.
    expect((await ledger.listTransactions("42")).map((item) => item.category)).toEqual(["Fees"]);

    const back = await ingestBankText(deps, owner, DEBORAH_BACK, { channel: "mac" });
    expect(back.outcomes[0].outcome).toBe("needs_label");
    const question = await questionFor(deps.loans, owner, back.outcomes[0].message);
    expect(question.text).toContain("Deborah Ama Zenaba Konadu owes you GH₵400.00. Is this paying you back?");
    expect(question.buttons[0][0].text).toBe("Yes, paying me back");

    const repaid = await applyLabel(deps, owner, back.outcomes[0].message.id, { kind: "repaid" });
    expect(repaid.text).toBe("Marked GH₵150.00 from Deborah Ama Zenaba Konadu as paying you back. Deborah Ama Zenaba Konadu owes you GH₵250.00 in total.");
  });

  it("asks who a loan was to when the payment doesn't say", async () => {
    const { deps, owner } = setup();
    const push = await held(
      deps,
      owner,
      "Your payment of GHS 58.50 to TELECEL PUSH has been completed at 2026-10-28 20:44:00. Your new balance: GHS 300.00. Fee was GHS 0.43. Financial Transaction Id: 92400000009.",
    );
    expect((await applyLabel(deps, owner, push.id, { kind: "lent" })).text).toBe("Who did you lend the GH₵58.50 to?");
    expect((await applyLabel(deps, owner, push.id, { kind: "lent", person: "kofi mensah" })).text).toContain("you lent Kofi Mensah GH₵58.50");
  });
});

describe("answering in your own words", () => {
  it("clears several payments from one message and can undo them", async () => {
    const { deps, bank, ledger, loans, owner } = setup();
    const adisah = await held(deps, owner, ADISAH);
    await held(deps, owner, ADISAH_AGAIN);
    const deborah = await held(deps, owner, DEBORAH);
    await held(deps, owner, GODWIN);

    const resolve: LabelResolver = async () => [
      { messageIds: [adisah.id], label: { kind: "category", category: "Food", description: "Office snacks" } },
      { messageIds: [deborah.id], label: { kind: "lent", person: "Debby" } },
    ];
    const reply = await answerLabelReply(deps, owner, "all money to Adisa was snacks for the office, and the 400 to debby was a loan", resolve);
    expect(reply?.text).toContain("Filed GH₵10.50 under Food. I'll file Adisah Anabzo as Food from now on. I've also filed 1 other payment to Adisah Anabzo the same way.");
    expect(reply?.text).toContain("you lent Deborah Ama Zenaba Konadu GH₵400.00");
    expect(reply?.text).toContain("Sorted 3 payments. Say “undo” if I got any wrong.");
    expect(reply?.text).toContain("Last one: GH₵61.50 to Godwin Abaya");
    expect((await ledger.listTransactions("42")).filter((item) => item.category === "Food" && item.description === "Office snacks")).toHaveLength(2);
    expect(bank.rules.get("adisah anabzo")?.category).toBe("Food");

    const undone = await answerLabelReply(deps, owner, "undo", resolve);
    expect(undone?.text).toContain("Those 3 payments are waiting for a label again.");
    expect(await bank.listMessages("42", "needs_label")).toHaveLength(4);
    expect((await ledger.listTransactions("42")).filter((item) => item.status === "active" && item.category === "Food")).toHaveLength(0);
    expect(await loans.list("42")).toHaveLength(0);
    expect(bank.rules.size).toBe(0);
  });

  it("only files what the message points at, even when the model guesses wider", async () => {
    const { deps, bank, ledger, loans, owner } = setup();
    // Adisah was sorted earlier, so nothing to Adisah is waiting.
    const adisah = await held(deps, owner, ADISAH);
    await applyLabel(deps, owner, adisah.id, { kind: "category", category: "Food", description: "Office snacks" });
    const godwin = await held(deps, owner, GODWIN);
    const deborah = await held(deps, owner, DEBORAH);
    const mitch = await held(deps, owner, "Payment received for GHS 1,000.00 from MITCH IVAN ABAKAH Current Balance: GHS 1,210.00 . Available Balance: GHS 1,210.00. Reference: . Transaction ID: 92400000010. TRANSACTION FEE: 0.00");
    await answerLabelReply(deps, owner, "what are those?", async () => []);

    // What the small model actually did with this message: snacks for everyone it could see.
    const resolve: LabelResolver = async () => [
      { messageIds: [godwin.id, mitch.id], label: { kind: "category", category: "Food", description: "Office snacks" } },
      { messageIds: [deborah.id], label: { kind: "lent", person: "Debby" } },
    ];
    const reply = await answerLabelReply(deps, owner, "everything to Adisah was office snacks, the 400 to Debby was a loan,", resolve);
    expect(reply?.text).toContain("you lent Deborah Ama Zenaba Konadu GH₵400.00");
    expect(reply?.text).toContain("Adisah Anabzo is already sorted: I file them under Food · Office snacks.");
    expect(reply?.text).not.toContain("Godwin Abaya as Food");
    expect(reply?.text).not.toContain("doesn't fit");
    expect((await bank.listMessages("42", "needs_label")).map((item) => item.id).sort()).toEqual([godwin.id, mitch.id].sort());
    expect(bank.rules.has("godwin abaya")).toBe(false);
    expect((await ledger.listTransactions("42")).filter((item) => item.description === "Office snacks")).toHaveLength(1);
    expect(await loans.list("42")).toHaveLength(1);
  });

  it("files a payment picked by amount without remembering the payee", async () => {
    const { deps, bank, owner } = setup();
    const godwin = await held(deps, owner, GODWIN);
    await held(deps, owner, ADISAH);
    const reply = await answerLabelReply(deps, owner, "the 61.50 was fuel", async () => [
      { messageIds: [godwin.id], label: { kind: "category", category: "Transport", description: "Fuel", forMonth: null } },
    ]);
    expect(reply?.text).toContain("Filed GH₵61.50 under Transport.");
    expect(bank.rules.size).toBe(0);
  });

  it("still answers the question just asked from a bare reply", async () => {
    const { deps, bank, owner } = setup();
    await held(deps, owner, GODWIN);
    const asked = await answerLabelReply(deps, owner, "what are those?", async () => []);
    const reply = await answerLabelReply(deps, owner, "fuel", async () => [
      { messageIds: [asked!.next!.id], label: { kind: "category", category: "Transport", description: "Fuel" } },
    ]);
    expect(reply?.text).toContain("I'll file Godwin Abaya as Transport from now on.");
    expect(bank.rules.get("godwin abaya")?.category).toBe("Transport");
  });

  it("lets ordinary messages through", async () => {
    const { deps, owner } = setup();
    await held(deps, owner, GODWIN);
    expect(await answerLabelReply(deps, owner, "how much did I spend this week?", async () => [])).toBeNull();
    // "undo" with nothing to undo is left for the normal undo of a logged expense.
    expect(await answerLabelReply(deps, owner, "undo", async () => [])).toBeNull();
  });
});

describe("waiting payments in the main conversation", () => {
  it("numbers them for the model and maps its answer back to them", async () => {
    const { deps, owner } = setup();
    const adisah = await held(deps, owner, ADISAH);
    const godwin = await held(deps, owner, GODWIN);
    await answerLabelReply(deps, owner, "what are those?", async () => []);
    const waiting = await waitingPayments(deps, owner);
    expect(waiting?.lines[0]).toContain("1. OUT GH₵10.50 to Adisah Anabzo");
    expect(waiting?.lines[1]).toContain("2. OUT GH₵61.50 to Godwin Abaya");
    expect(waiting?.current?.id).toBe(adisah.id);

    const prompt = buildSystemPrompt({ today: "2026-10-29", timezone: "Africa/Accra", currency: "GHS", recent: [], waiting: { lines: waiting!.lines, current: waiting!.currentNumber } });
    expect(prompt).toContain("Waiting payments:\n1. OUT GH₵10.50 to Adisah Anabzo");
    expect(prompt).toContain("answers payment 1, which the user was just asked about");
    expect(prompt).toContain('"type":"label_payments"');
    expect(buildSystemPrompt({ today: "2026-10-29", timezone: "Africa/Accra", currency: "GHS", recent: [] })).not.toContain("label_payments");

    const action = parseModelOutput('{"type":"label_payments","answers":[{"items":[2,9],"action":"category","category":"Transport","description":"Fuel"}]}');
    expect(action.success && action.data.type === "label_payments" ? resolvedFrom(action.data.answers, waiting!.listed) : null).toEqual([
      { messageIds: [godwin.id], label: { kind: "category", category: "Transport", description: "Fuel", forMonth: null } },
    ]);
  });
});

describe("loans by chat", () => {
  function context(loans: MemoryLoanStore, store = new MemoryFinanceStore()): ActionContext {
    return {
      profile: profile(42),
      store,
      now: new Date("2026-10-29T10:00:00.000Z"),
      updateId: 77,
      chatId: 100,
      confirmTransactions: "auto",
      pendingTtlMs: 60_000,
      createId: () => "3f2a1c4e-1111-4111-8111-111111111300",
      createActionId: () => "loanaction01",
      loans,
    };
  }

  it("confirms a cash loan, then answers who owes what", async () => {
    const loans = new MemoryLoanStore();
    const store = new MemoryFinanceStore();
    const ctx = context(loans, store);
    const asked = await handleAction({ type: "record_loan", direction: "lent", person: "kofi", amount: "100.00", currency: "GHS", date: null, note: "cash" }, ctx);
    expect(asked.kind).toBe("confirm");
    expect(asked.text).toContain("Record that you lent Kofi GH₵100.00");
    const pending = await store.getPendingAction("loanaction01");
    const done = await executeConfirmed(pendingPayloadSchema.parse(JSON.parse(pending!.payloadJson)), ctx);
    expect(done.text).toBe("Done. Kofi owes you GH₵100.00 in total.");

    const all = await handleAction({ type: "get_loans", person: null }, ctx);
    expect(all.text).toBe("One person owes you money:\n• Kofi: GH₵100.00");
    const one = await handleAction({ type: "get_loans", person: "Kofi" }, ctx);
    expect(one.text).toBe("Kofi owes you GH₵100.00. You lent GH₵100.00 in total.");
    const nobody = await handleAction({ type: "get_loans", person: "Ama" }, ctx);
    expect(nobody.text).toBe("I don't have any loans with Ama on record.");
  });
});

const MITCH =
  "Payment received for GHS 1,000.00 from MITCH IVAN ABAKAH Current Balance: GHS 1,210.00 . Available Balance: GHS 1,210.00. Reference: . Transaction ID: 92400000030. TRANSACTION FEE: 0.00";
const TO_MITCH =
  "Payment made for GHS 300.00 to MITCH IVAN ABAKAH Current Balance: GHS 910.00 . Available Balance: GHS 910.00. Reference: . Transaction ID: 92400000031. Fee charged: GHS0.00";

describe("borrowing through bank labels", () => {
  it("records money someone lent you, then asks if money to them is paying it back", async () => {
    const { deps, ledger, owner } = setup();
    const lent = await held(deps, owner, MITCH);
    expect(labelButtons(lent, "Hans", { lending: true }).flat().map((button) => button.text)).toContain("Lent to me");

    const reply = await answerLabelReply(deps, owner, "the 1000 from Mitch was a loan to me, so I owe him", async () => [
      { messageIds: [lent.id], label: { kind: "borrowed", person: null } },
    ]);
    expect(reply?.text).toBe("Noted: Mitch Ivan Abakah lent you GH₵1,000.00. It isn't counted as income. You owe Mitch Ivan Abakah GH₵1,000.00 in total.");
    expect(await ledger.listTransactions("42")).toEqual([]);

    const back = await ingestBankText(deps, owner, TO_MITCH, { channel: "mac" });
    expect(back.outcomes[0].outcome).toBe("needs_label");
    const question = await questionFor(deps.loans, owner, back.outcomes[0].message);
    expect(question.text).toContain("You owe Mitch Ivan Abakah GH₵1,000.00. Is this paying them back?");
    expect(question.buttons[0][0].text).toBe("Yes, paying them back");
    const paid = await applyLabel(deps, owner, back.outcomes[0].message.id, { kind: "paid_back" });
    expect(paid.text).toBe("Marked GH₵300.00 to Mitch Ivan Abakah as paying them back. It isn't counted as spending. You owe Mitch Ivan Abakah GH₵700.00 in total.");
  });

  it("won't call money a repayment from someone who owes nothing", async () => {
    const { deps, bank, owner } = setup();
    const lent = await held(deps, owner, MITCH);
    const result = await applyLabel(deps, owner, lent.id, { kind: "repaid" });
    expect(result).toEqual({
      ok: false,
      text: "Mitch Ivan Abakah doesn't owe you anything that I know of, so GH₵1,000.00 can't be them paying you back. If they lent it to you, say so and I'll note that you owe them.",
    });
    expect((await bank.getMessage("42", lent.id))?.status).toBe("needs_label");
  });

  it("fixes what was just filed when you correct it", async () => {
    const { deps, bank, ledger, loans, owner } = setup();
    const lent = await held(deps, owner, MITCH);
    await held(deps, owner, GODWIN);
    await answerLabelReply(deps, owner, "Mitch was a gift", async () => [{ messageIds: [lent.id], label: { kind: "category", category: "Gift" } }]);
    expect((await ledger.listTransactions("42")).filter((item) => item.status === "active").map((item) => item.category)).toContain("Gift");

    const waiting = await waitingPayments(deps, owner);
    expect(waiting?.lines.at(-1)).toContain("IN GH₵1,000.00 from Mitch Ivan Abakah");
    expect(waiting?.lines.at(-1)).toContain("JUST FILED as Gift");

    // "he" names no one, but a correction of the one payment just filed still lands on it.
    const fixed = await answerLabelReply(deps, owner, "No I mean he gave me a loan so now I owe him", async ({ waiting: list }) => [
      { messageIds: [list.recent[0].message.id], label: { kind: "borrowed", person: null } },
    ]);
    expect(fixed?.text).toContain("Fixed. Noted: Mitch Ivan Abakah lent you GH₵1,000.00.");
    expect((await ledger.listTransactions("42")).filter((item) => item.status === "active").map((item) => item.category)).not.toContain("Gift");
    expect(loans.entries.map((item) => item.kind)).toEqual(["borrowed"]);
    expect(bank.rules.get("mitch ivan abakah")).toBeUndefined();
    expect((await bank.getMessage("42", lent.id))?.status).toBe("borrowed");
  });

  it("says who you owe when asked", async () => {
    const loans = new MemoryLoanStore();
    const base = { currency: "GHS", note: "", bankMessageId: null };
    await loans.add("42", { ...base, person: "Mitch Ivan Abakah", kind: "borrowed", amount: "1000.00", occurredAt: "2026-10-28T11:44:00.000Z" });
    await loans.add("42", { ...base, person: "Kofi", kind: "lent", amount: "100.00", occurredAt: "2026-10-20T09:00:00.000Z" });
    const ctx = {
      profile: profile(42),
      store: new MemoryFinanceStore(),
      now: new Date("2026-10-29T10:00:00.000Z"),
      updateId: 78,
      chatId: 100,
      confirmTransactions: "auto",
      pendingTtlMs: 60_000,
      createId: () => "3f2a1c4e-1111-4111-8111-111111111301",
      createActionId: () => "loanaction02",
      loans,
    } satisfies ActionContext;
    expect((await handleAction({ type: "get_loans", person: null }, ctx)).text).toBe("One person owes you money:\n• Kofi: GH₵100.00\n\nYou owe:\n• Mitch Ivan Abakah: GH₵1,000.00");
    expect((await handleAction({ type: "get_loans", person: "Mitch" }, ctx)).text).toBe("You owe Mitch Ivan Abakah GH₵1,000.00. They lent you GH₵1,000.00 in total.");
    const asked = await handleAction({ type: "record_loan", direction: "borrowed", person: "Ama", amount: "50.00", currency: "GHS", date: null, note: null }, ctx);
    expect(asked.text).toContain("Record that Ama lent you GH₵50.00");
  });
});

describe("notes about people already sorted", () => {
  it("doesn't mention Deborah when Debra was the one just filed", async () => {
    const { deps, owner } = setup();
    const deborah = await held(deps, owner, DEBORAH);
    await applyLabel(deps, owner, deborah.id, { kind: "lent" });
    const debrah = await held(deps, owner, "Payment made for GHS 40.50 to BENJAMIN DEBRAH Current Balance: GHS 159.50 . Available Balance: GHS 159.50. Reference: . Transaction ID: 92400000032. Fee charged: GHS0.00");
    const reply = await answerLabelReply(deps, owner, "Debra was okada home just now", async () => [
      { messageIds: [debrah.id], label: { kind: "category", category: "Transport", description: "Okada" } },
    ]);
    expect(reply?.text).toContain("Filed GH₵40.50 under Transport");
    expect(reply?.text).not.toContain("Deborah");
  });
});
