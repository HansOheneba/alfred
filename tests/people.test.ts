import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "@/lib/ai/prompts";
import { applyLabel, ingestBankText, type IngestDeps } from "@/lib/bank/ingest";
import { questionFor, summarize } from "@/lib/bank/notify";
import { parseBankText, purposeOf } from "@/lib/bank/parse";
import { MemoryBankStore } from "@/lib/bank/store";
import { handleAction, type ActionContext } from "@/lib/finance/action-router";
import { MemoryLoanStore } from "@/lib/finance/loans";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { MemoryPeopleStore, notesForPrompt } from "@/lib/people/store";
import { profile } from "./helpers";

const NOW = new Date("2026-10-29T10:00:00.000Z");
const FIBRE =
  "Payment for GHS444.00 to Broadband Bundle OVA.Current Balance: GHS 680.15. Transaction Id: 92377985325. Fee charged: GHS0.00,Tax Charged 0.Download the MoMo App for a Faster & Easier Experience. Click here: https://mtnmymomo.onelink.me/XJOt/MoMo";
const WENDY =
  "Payment received for GHS 200.00 from WENDY AMANDA DEDO KWASHIE Current Balance: GHS 311.55 . Available Balance: GHS 311.55. Reference: WENDY AMANDA DEDO KWASHIE ,03xxxxxx61,Transfer to HANS OHENEBA ADUSE OPOKU WiFi (GIP) from ACCESS Bank Limited. Transaction ID: 92353507300. TRANSACTION FEE: 0.00";
const FROM_GCB =
  "Payment received for GHS 200.00 from HANS OHENEBA ADUSE OPOKU  Current Balance: GHS 511.55 . Available Balance: GHS 511.55. Reference: HANS OHENEBA ADUSE OPOKU ,10xxxxxx87,GIPS Transfer from GCB Bank. Transaction ID: 92353669683. TRANSACTION FEE: 0.00";
const GRACE =
  "Payment received for GHS 125.00 from GRACE OPPONG  Current Balance: GHS 805.15 . Available Balance: GHS 805.15. Reference: 1. Transaction ID: 92392563341. TRANSACTION FEE: 0.00";
const GRACE_AGAIN = GRACE.replace("92392563341", "92392563399").replace("805.15", "930.15");

function setup() {
  const bank = new MemoryBankStore();
  bank.names = ["Hans Oheneba Aduse Opoku"];
  const ledger = new MemoryFinanceStore();
  const people = new MemoryPeopleStore();
  let sequence = 0;
  const deps: IngestDeps = {
    bank,
    ledger,
    loans: new MemoryLoanStore(),
    people,
    now: NOW,
    createId: () => `7a1b2c3d-3333-4333-8333-${String(++sequence).padStart(12, "0")}`,
  };
  return { bank, ledger, people, deps, owner: profile(42, { preferredName: "Hans" }) };
}

describe("reading more MoMo texts", () => {
  it("reads bundle and bill payments, and files broadband as home internet", async () => {
    const { deps, ledger, owner } = setup();
    const [parsed] = parseBankText(FIBRE, { now: NOW, timeZone: "Africa/Accra" });
    expect([parsed.direction, parsed.amount, parsed.counterparty]).toEqual(["out", "444.00", "Broadband Bundle OVA"]);
    const result = await ingestBankText(deps, owner, FIBRE, { channel: "mac" });
    expect(result.outcomes[0].outcome).toBe("recorded");
    expect((await ledger.listTransactions("42"))[0]).toMatchObject({ category: "Utilities", description: "Home internet", amount: "444.00" });
  });

  it("doesn't mistake money sent to you for your own transfer, and keeps the sender's note", async () => {
    const { deps, owner } = setup();
    const wendy = (await ingestBankText(deps, owner, WENDY, { channel: "mac" })).outcomes[0];
    expect(wendy.outcome).toBe("needs_label");
    expect(purposeOf(wendy.message)).toBe("WiFi");
    expect((await questionFor(deps.loans, owner, wendy.message)).text).toMatch(/came in from Wendy Amanda Dedo Kwashie · .+, marked “WiFi”\. What was it\?/);
    // Your own money from GCB is still your own money.
    expect((await ingestBankText(deps, owner, FROM_GCB, { channel: "mac" })).outcomes[0].outcome).toBe("transfer");
    expect(purposeOf({ raw: GRACE, counterparty: "GRACE OPPONG" })).toBe("");
  });
});

describe("chipping in toward a bill", () => {
  it("lowers the bill's category instead of counting as income, and learns the sender", async () => {
    const { deps, bank, ledger, owner } = setup();
    await ingestBankText(deps, owner, FIBRE, { channel: "mac" });
    const grace = (await ingestBankText(deps, owner, GRACE, { channel: "mac" })).outcomes[0].message;
    const done = await applyLabel(deps, owner, grace.id, { kind: "chip_in", category: "Utilities", description: "Fibre" });
    expect(done.text).toBe(
      "Counted GH₵125.00 from Grace Oppong as their share of Utilities, so it lowers what you spent there instead of counting as income. I'll treat money from Grace Oppong this way from now on.",
    );
    const utilities = (await ledger.listTransactions("42")).filter((item) => item.category === "Utilities");
    expect(utilities.map((item) => item.amount)).toEqual(["444.00", "-125.00"]);
    expect(utilities.every((item) => item.type === "expense")).toBe(true);
    expect(bank.rules.get("grace oppong")).toMatchObject({ kind: "chip_in", category: "Utilities" });

    // Next month it's filed the same way on its own.
    const again = await ingestBankText(deps, owner, GRACE_AGAIN, { channel: "mac" });
    expect(again.outcomes[0]).toMatchObject({ outcome: "recorded", category: "Utilities", chipIn: true });
    expect(summarize(again.outcomes, "GHS")).toEqual(["Counted GH₵125.00 from Grace Oppong as their share of Utilities."]);
  });

  it("credits the person it's really from when someone sends it for them, without learning the sender", async () => {
    const { deps, bank, ledger, owner } = setup();
    const grace = (await ingestBankText(deps, owner, GRACE, { channel: "mac" })).outcomes[0].message;
    const done = await applyLabel(deps, owner, grace.id, { kind: "chip_in", category: "Utilities", description: "the fibre", person: "Cyril" });
    expect(done.text).toBe("Counted GH₵125.00 from Grace Oppong as Cyril's share of Utilities, so it lowers what you spent there instead of counting as income.");
    expect((await ledger.listTransactions("42"))[0]).toMatchObject({ amount: "-125.00", description: "Cyril's share of the fibre, sent by Grace Oppong" });
    // Grace may send money for other reasons, so she isn't filed automatically next time.
    expect(bank.rules.has("grace oppong")).toBe(false);
  });

  it("only takes money coming in", async () => {
    const { deps, owner } = setup();
    const out = (await ingestBankText(deps, owner, "Payment made for GHS 39.00 to ROSE ASARE Current Balance: GHS 742.15 . Available Balance: GHS 742.15. Reference: . Transaction ID: 92412812671. Fee charged: GHS0.00", { channel: "mac" })).outcomes[0].message;
    expect((await applyLabel(deps, owner, out.id, { kind: "chip_in", category: "Utilities" })).ok).toBe(false);
  });
});

describe("what you tell Alfred about people", () => {
  function context(people: MemoryPeopleStore): ActionContext {
    return {
      profile: profile(42),
      store: new MemoryFinanceStore(),
      now: NOW,
      updateId: 9,
      chatId: 100,
      confirmTransactions: "auto",
      pendingTtlMs: 60_000,
      createId: () => "3f2a1c4e-1111-4111-8111-111111111400",
      createActionId: () => "peopleaction1",
      people,
      payeeNames: async () => ["Grace Oppong", "Wendy Amanda Dedo Kwashie"],
    };
  }

  it("remembers a note under the full name from your texts, and forgets it", async () => {
    const people = new MemoryPeopleStore();
    const saved = await handleAction({ type: "remember_person", name: "Grace", note: "Cyril's friend. Usually sends money on his behalf." }, context(people));
    expect(saved.text).toBe("Noted. Grace Oppong: Cyril's friend. Usually sends money on his behalf. I'll keep that in mind when their payments come in.");
    expect(await notesForPrompt(people, "42")).toEqual(["Grace Oppong: Cyril's friend. Usually sends money on his behalf."]);
    expect((await handleAction({ type: "forget_person", name: "grace" }, context(people))).text).toBe("Forgotten. I no longer have a note about Grace Oppong.");
    expect(people.people.size).toBe(0);
  });

  it("shows notes to the model and mentions them, or asks who someone is, when asking about a payment", async () => {
    const { deps, people, owner } = setup();
    await people.save("42", { name: "Grace Oppong", note: "Cyril's friend, usually sends money for him." });
    const grace = (await ingestBankText(deps, owner, GRACE, { channel: "mac" })).outcomes[0].message;
    const wendy = (await ingestBankText(deps, owner, WENDY, { channel: "mac" })).outcomes[0].message;
    expect((await questionFor(deps.loans, owner, grace, people)).text).toContain("(You told me: Cyril's friend, usually sends money for him.)");
    expect((await questionFor(deps.loans, owner, wendy, people)).text).toContain("tell me who Wendy Amanda Dedo Kwashie is and I'll remember.");

    const prompt = buildSystemPrompt({ today: "2026-10-29", timezone: "Africa/Accra", currency: "GHS", recent: [], people: await notesForPrompt(people, "42") });
    expect(prompt).toContain("What the user has told you about people. Use it to understand their payments and messages:\nGrace Oppong: Cyril's friend, usually sends money for him.");
    expect(prompt).toContain('"type":"remember_person"');
  });
});
