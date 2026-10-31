import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "@/lib/ai/prompts";
import { applyLabel, bankAccess, ingestBankText, type IngestDeps } from "@/lib/bank/ingest";
import { accountOf } from "@/lib/bank/parse";
import { answerLabelReply, labelShortcut } from "@/lib/bank/reply";
import { MemoryBankStore } from "@/lib/bank/store";
import { handleAction, type ActionContext } from "@/lib/finance/action-router";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { parseModelOutput } from "@/lib/finance/schemas";
import { aboutForPrompt, MemoryNotebookStore } from "@/lib/notebook/store";
import { profile } from "./helpers";

const MUM = "Hi Hans Oheneba Aduse Your A/C No:XXXX0543 has been debited GHS12.00 Desc: ESERVICE BUNDLE CHARGE Date: 2026-10-30 22:55 Bal: GHS 50,085.00";
const MUM_BALANCE =
  "Hi Hans Oheneba Aduse Your A/C No:XXXX0543 has been credited GHS300.00 Desc: TRANSFER Date: 2026-10-31 08:10 Balance: GHS 50,385.00";
const MOMO =
  "Payment made for GHS 22.50 to ELLEN OHENEWA OBENG-DARKO Current Balance: GHS 1512.11 . Available Balance: GHS 1512.11. Reference: . Transaction ID: 92694674830. Fee charged: GHS0.00";

function setup() {
  const bank = new MemoryBankStore();
  const notebook = new MemoryNotebookStore();
  bank.notebook = notebook;
  const ledger = new MemoryFinanceStore();
  let sequence = 0;
  const deps: IngestDeps = {
    bank,
    ledger,
    now: new Date("2026-10-31T05:20:00.000Z"),
    createId: () => `7a1b2c3d-3333-4333-8333-${String(++sequence).padStart(12, "0")}`,
  };
  const owner = profile(42, { preferredName: "Hans" });
  const ctx: ActionContext = {
    profile: owner,
    store: ledger,
    now: deps.now,
    updateId: 90,
    chatId: 100,
    confirmTransactions: "auto",
    pendingTtlMs: 60_000,
    createId: () => "3f2a1c4e-1111-4111-8111-111111111400",
    createActionId: () => "notebook01",
    bank: bankAccess(bank, notebook, owner.profileId),
    notebook,
  };
  return { bank, notebook, ledger, deps, owner, ctx };
}

describe("accounts that aren't the person's", () => {
  it("reads the account a text is about", () => {
    expect(accountOf(MUM)).toBe("0543");
    expect(accountOf(MOMO)).toBeNull();
  });

  it("ignores an account from chat, notes why, and leaves its texts out from then on", async () => {
    const { bank, notebook, deps, owner, ctx } = setup();
    const held = (await ingestBankText(deps, owner, MUM, { channel: "mac" })).outcomes[0].message;
    expect(held.status).toBe("needs_label");

    const action = parseModelOutput('{"type":"ignore_account","account":"0543","note":"My mum\'s account. I manage it for her."}');
    expect(action.success).toBe(true);
    const reply = await handleAction(action.success ? action.data : { type: "help" }, ctx);
    expect(reply.text).toContain("Noted in your notebook: “My mum's account. I manage it for her”.");
    expect(reply.text).toContain("ignore texts from the account ending 0543");
    expect(reply.text).toContain("left out the payment from it that was waiting");
    expect((await bank.getMessage("42", held.id))?.status).toBe("skipped");
    expect(notebook.notes.map((item) => item.account)).toEqual(["0543"]);

    // Its balance never shows as the person's money.
    const later = await ingestBankText(deps, owner, MUM_BALANCE, { channel: "mac" });
    expect(later.outcomes).toEqual([]);
    expect(await bank.latestBalances("42")).toEqual([]);

    expect(await aboutForPrompt(notebook, "42")).toEqual(["My mum's account. I manage it for her. (Texts from the account ending 0543 are ignored.)"]);
  });
});

describe("the notebook", () => {
  it("remembers facts about the person and puts them in the prompt", async () => {
    const { notebook, ctx } = setup();
    const reply = await handleAction({ type: "remember_about_me", note: "I'm paid on the 25th of each month." }, ctx);
    expect(reply.text).toBe("Noted in your notebook: “I'm paid on the 25th of each month”. You can see and edit it on the Notebook page.");
    const prompt = buildSystemPrompt({ today: "2026-10-31", timezone: "Africa/Accra", currency: "GHS", recent: [], about: await aboutForPrompt(notebook, "42") });
    expect(prompt).toContain("Your notebook on the user");
    expect(prompt).toContain("I'm paid on the 25th of each month.");
    expect(prompt).toContain('"type":"ignore_account"');
  });
});

describe("what's left", () => {
  it("includes the balances from the latest bank texts", async () => {
    const { deps, owner, ctx } = setup();
    await ingestBankText(deps, owner, MOMO, { channel: "mac" });
    const reply = await handleAction({ type: "get_financial_overview", period: "this_month", month: null, year: null, start_date: null, end_date: null }, ctx);
    expect(reply.text).toContain("Balances from your latest bank texts");
    expect(reply.text).toContain("The totals come from recorded transactions; the balances come from your bank texts.");
    expect(reply.text).not.toContain("It is not a bank balance.");
    expect(reply.text).toMatch(/• MoMo: GH₵1,512\.11 \(Sat 31 Oct, 05:20\)/);
  });
});

describe("talking about waiting payments", () => {
  it("asks the next question when told to ask", async () => {
    const { deps, owner } = setup();
    await ingestBankText(deps, owner, MOMO, { channel: "mac" });
    for (const text of ["Ask", "No I mean ask your questions", "ask me", "ok ask away"]) {
      const reply = await labelShortcut(deps, owner, text);
      expect(reply?.text, text).toContain("One payment is waiting for a label.");
      expect(reply?.text, text).toContain("First: GH₵22.50 to Ellen Ohenewa Obeng-Darko");
      expect(reply?.buttons?.length, text).toBeGreaterThan(0);
    }
    expect(await labelShortcut(deps, owner, "can you ask Kofi for the money")).toBeNull();
  });

  it("doesn't call people already sorted because a word looks like their name", async () => {
    const { deps, owner } = setup();
    const ellen = (await ingestBankText(deps, owner, MOMO, { channel: "mac" })).outcomes[0].message;
    await applyLabel(deps, owner, ellen.id, { kind: "category", category: "Food", description: "Malt" });
    await ingestBankText(
      deps,
      owner,
      "Payment made for GHS 400.00 to DEBORAH AMA ZENABA KONTOH Current Balance: GHS 210.00 . Available Balance: GHS 210.00. Reference: . Transaction ID: 92400000001. Fee charged: GHS3.00",
      { channel: "mac" },
    ).then(async (result) => applyLabel(deps, owner, result.outcomes[0].message.id, { kind: "category", category: "People" }));
    const mum = (await ingestBankText(deps, owner, MUM, { channel: "mac" })).outcomes[0].message;
    const reply = await answerLabelReply(deps, owner, `That's a fee but ignore the bank that has these details ${MUM}`, async () => [
      { messageIds: [mum.id], label: { kind: "skip" } },
    ]);
    expect(reply?.text).toBe("Left GH₵12.00 out of your books.");
  });
});
