import { describe, expect, it } from "vitest";

import { ingestBankText, labelQuestion, type IngestDeps } from "@/lib/bank/ingest";
import { parseBankText } from "@/lib/bank/parse";
import { MemoryBankStore } from "@/lib/bank/store";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { profile } from "./helpers";

// Fictional sender, number and amounts.
const HUBTEL = "AMA KOFI MENSAH 233200000001 has sent you GHS 80.00 via https://hbtl.co/app with a Note: other";
const HUBTEL_NOTE = "AMA KOFI MENSAH 233200000001 has sent you GHS 45.00 via https://hbtl.co/app with a Note: Internet share";
const MOMO_CREDIT_INV = "Payment received for GHS 80.00 from Credit.Inv      Current Balance: GHS 1180.10 . Available Balance: GHS 1180.10. Reference: other. Transaction ID: 90000000001. TRANSACTION FEE: 0.00";
const at = new Date("2026-11-05T23:07:00.000Z");
const parse = (text: string, sender = "Hubtel") => parseBankText(text, { now: at, timeZone: "Africa/Accra", sender, loose: true });

function setup() {
  const bank = new MemoryBankStore();
  let sequence = 0;
  const deps: IngestDeps = { bank, ledger: new MemoryFinanceStore(), now: at, createId: () => `7a1b2c3d-1111-4111-8111-${String(++sequence).padStart(12, "0")}` };
  return { bank, deps, owner: profile(42) };
}

describe("Hubtel 'has sent you' alerts", () => {
  it("reads them as money in, from the sender, without the phone number", () => {
    expect(parse(HUBTEL)).toEqual([expect.objectContaining({ source: "hubtel", direction: "in", amount: "80.00", counterparty: "AMA KOFI MENSAH", reference: "" })]);
  });

  it("keeps a real note as the reference", () => {
    expect(parse(HUBTEL_NOTE)[0]).toMatchObject({ direction: "in", amount: "45.00", reference: "Internet share" });
  });

  it("never reads 'sent you' as money going out, even from an unknown sender", () => {
    expect(parse("KOFI has sent you GHS 12.00. Thanks", "")[0]?.direction ?? "in").toBe("in");
  });

  it("asks about the Hubtel alert as money in from the sender when no MoMo credit arrives", async () => {
    const { deps, owner } = setup();
    const result = await ingestBankText(deps, owner, HUBTEL, { channel: "shortcut", sender: "Hubtel", receivedAt: at });
    expect(result.outcomes).toHaveLength(1);
    const [outcome] = result.outcomes;
    expect(outcome.outcome).toBe("needs_label");
    expect(labelQuestion(outcome.message, owner.timezone)).toMatch(/came in from Ama Kofi Mensah/);
  });

  it.each([
    ["Hubtel first", [[HUBTEL, "Hubtel"], [MOMO_CREDIT_INV, "MobileMoney"]]],
    ["MoMo first", [[MOMO_CREDIT_INV, "MobileMoney"], [HUBTEL, "Hubtel"]]],
  ] as const)("counts the money once when MoMo also reports it (%s)", async (_order, texts) => {
    const { bank, deps, owner } = setup();
    for (const [text, sender] of texts) await ingestBankText(deps, owner, text, { channel: "shortcut", sender, receivedAt: at });
    const messages = await bank.listMessages("42");
    const hubtel = messages.find((item) => item.source === "hubtel")!;
    const momo = messages.find((item) => item.source === "momo")!;
    expect(hubtel.status).toBe("skipped");
    expect(momo).toMatchObject({ status: "needs_label", direction: "in", counterparty: "AMA KOFI MENSAH" });
    expect(labelQuestion(momo, owner.timezone)).toMatch(/came in from Ama Kofi Mensah/);
    expect(await bank.listMessages("42", "needs_label")).toHaveLength(1);
  });

  it("leaves a MoMo credit of a different amount alone", async () => {
    const { bank, deps, owner } = setup();
    await ingestBankText(deps, owner, HUBTEL_NOTE, { channel: "shortcut", sender: "Hubtel", receivedAt: at });
    await ingestBankText(deps, owner, MOMO_CREDIT_INV, { channel: "shortcut", sender: "MobileMoney", receivedAt: at });
    expect(await bank.listMessages("42", "needs_label")).toHaveLength(2);
  });
});
