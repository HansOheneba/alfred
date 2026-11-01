import { describe, expect, it } from "vitest";

import { applyLabel, ingestBankText, labelQuestion, TRUSTED_AFTER, type IngestDeps } from "@/lib/bank/ingest";
import { checkAlert, createUnknownTextReader, sourceSlug, type ModelAlert, type UnknownTextReader } from "@/lib/bank/read-unknown";
import { MemoryBankStore } from "@/lib/bank/store";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { profile } from "./helpers";

// A made-up bank wording that no rule covers.
const ECO = (amount: string, balance: string, ref: string) =>
  `Your acct 01xxxx77 was debited GHS ${amount} for POS purchase at KOALA SUPERMARKET on 02-NOV-26. Avl Bal GHS ${balance}. Ref ${ref}`;
const now = new Date("2026-11-02T09:00:00.000Z");
const options = { sender: "Ecobank", now };

const alert = (overrides: Partial<ModelAlert> = {}): ModelAlert => ({
  moves_money: true,
  direction: "out",
  amount: "250.00",
  fee: null,
  balance: "1,204.50",
  counterparty: "KOALA SUPERMARKET",
  transaction_id: "PS9981",
  on_hold: false,
  bank: "Ecobank",
  ...overrides,
});

describe("reading texts from banks without rules", () => {
  const text = ECO("250.00", "1,204.50", "PS9981");

  it("keeps a reading the text backs up", () => {
    expect(checkAlert(text, alert(), options)).toMatchObject({
      source: "ecobank",
      direction: "out",
      amount: "250.00",
      balance: "1204.50",
      counterparty: "KOALA SUPERMARKET",
      externalId: "PS9981",
      occurredAt: now.toISOString(),
    });
  });

  it("drops anything the model made up", () => {
    // An amount that isn't in the text drops the whole reading.
    expect(checkAlert(text, alert({ amount: "2500.00" }), options)).toBeNull();
    // A payee, balance or reference that isn't in the text is left blank instead.
    expect(checkAlert(text, alert({ counterparty: "SHOPRITE", balance: "99.00", transaction_id: "XX1234" }), options)).toMatchObject({
      counterparty: "",
      balance: null,
      externalId: null,
    });
    expect(checkAlert(text, alert({ moves_money: false }), options)).toBeNull();
    // A person's message about money never counts, even if the model thinks it moved money.
    expect(checkAlert(text, alert({ from_provider: false }), options)).toBeNull();
    expect(checkAlert(text, alert({ direction: null }), options)).toBeNull();
  });

  it("tidies a card merchant code the model copied", () => {
    const card = "Card purchase GHS 120.00 at RUNWAY_A1B2C3D4E5_NEW YORK_US. Bal GHS 80.00";
    expect(checkAlert(card, alert({ amount: "120.00", balance: "80.00", counterparty: "RUNWAY_A1B2C3D4E5_NEW YORK_US", transaction_id: null }), options)?.counterparty).toBe("RUNWAY");
  });

  it("names the source after the sender, or the bank the model saw", () => {
    expect(sourceSlug("Ecobank", null)).toBe("ecobank");
    expect(sourceSlug("Fidelity Bank", null)).toBe("fidelity");
    expect(sourceSlug("StanbicBank GH", null)).toBe("stanbic");
    expect(sourceSlug("FidelityBank", null)).toBe("fidelity");
    expect(sourceSlug("MobileMoney", null)).toBe("momo");
    expect(sourceSlug("+233241234567", "CalBank")).toBe("calbank");
    expect(sourceSlug(null, null)).toBe("other");
  });

  it("reads the model's JSON and survives a bad answer", async () => {
    const fake = (body: string) => (async () => new Response(JSON.stringify({ choices: [{ message: { content: body }, finish_reason: "stop" }] }))) as unknown as typeof fetch;
    const settings = { apiKey: "test", model: "deepseek-test" };
    const good = createUnknownTextReader(settings, fake(JSON.stringify({ alerts: [alert()] })));
    expect((await good(text, options)).map((item) => item.amount)).toEqual(["250.00"]);
    const bad = createUnknownTextReader(settings, fake("not json"));
    expect(await bad(text, options)).toEqual([]);
  });
});

describe("learning a new bank", () => {
  function setup() {
    const bank = new MemoryBankStore();
    const ledger = new MemoryFinanceStore();
    let sequence = 0;
    // Stands in for the model: reads the amount, balance and reference out of the made-up wording.
    const readUnknown: UnknownTextReader = async (text, opts) => {
      const [, amount, balance, ref] = text.match(/debited GHS ([\d.]+) .* Avl Bal GHS ([\d,.]+)\. Ref (\w+)/) ?? [];
      const reading = amount ? checkAlert(text, alert({ amount, balance, transaction_id: ref }), opts) : null;
      return reading ? [reading] : [];
    };
    const deps: IngestDeps = {
      bank,
      ledger,
      now,
      readUnknown,
      createId: () => `7a1b2c3d-3333-4333-8333-${String(++sequence).padStart(12, "0")}`,
    };
    const owner = profile(42);
    return { deps, owner, bank, ledger, send: (text: string) => ingestBankText(deps, owner, text, { channel: "shortcut", sender: "Ecobank" }) };
  }

  it("asks about every payment until the person has confirmed a few, then files them on its own", async () => {
    const { deps, owner, send } = setup();
    for (let index = 0; index < TRUSTED_AFTER; index += 1) {
      const result = await send(ECO("250.00", `${1000 - index}.00`, `PS${index}000`));
      const message = result.outcomes[0].message;
      expect(result.outcomes[0].outcome).toBe("needs_label");
      expect(message.readBy).toBe("model");
      expect(labelQuestion(message, "Africa/Accra")).toContain("(I read this Ecobank text myself. If I got it wrong, tap Skip.)");
      await applyLabel(deps, owner, message.id, { kind: "category", category: "Food", description: "Groceries" });
    }
    const trusted = await send(ECO("250.00", "900.00", "PS9999"));
    expect(trusted.outcomes[0]).toMatchObject({ outcome: "recorded", category: "Food" });
  });

  it("lets the model, not the loose rule, decide on a forwarded text with no sender", async () => {
    const { deps, owner, bank } = setup();
    // A friend's text, forwarded by the phone without a sender: the loose rule would read it as money sent.
    const friend = "I have sent you GHS 50 for the fuel, check your momo";
    deps.readUnknown = async (text, opts) => [checkAlert(text, alert({ from_provider: false, amount: "50", direction: "in", counterparty: null, transaction_id: null, balance: null }), opts)].filter((item) => item !== null);
    const result = await ingestBankText(deps, owner, friend, { channel: "shortcut" });
    expect(result.found).toBe(0);
    expect(await bank.listMessages("42")).toEqual([]);
    // Without a model, the loose rule still reads MoMo wordings it has no exact rule for.
    deps.readUnknown = null;
    const fallback = await ingestBankText(deps, owner, "You have received GHS 20.00 from ABENA KYEI. Your new balance: GHS 80.00", { channel: "shortcut" });
    expect(fallback.found).toBe(1);
  });

  it("doesn't ask the model about MoMo or GCB texts the rules skipped", async () => {
    const { deps, owner } = setup();
    let calls = 0;
    deps.readUnknown = async () => {
      calls += 1;
      return [];
    };
    await ingestBankText(deps, owner, "Dear Customer, earn GHS 5 bonus when you top up today!", { channel: "shortcut", sender: "MobileMoney" });
    await ingestBankText(deps, owner, "Dear Customer, earn GHS 5 bonus when you top up today!", { channel: "shortcut", sender: "GCB Bank" });
    expect(calls).toBe(0);
  });
});
