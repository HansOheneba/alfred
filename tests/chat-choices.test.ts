import { describe, expect, it } from "vitest";

import { chatChoices } from "@/lib/accounts/chat-choices";
import { chatChoiceSchema } from "@/lib/accounts/chat-request";
import { ingestBankText } from "@/lib/bank/ingest";
import { askNext, chooseLabel, currentQuestion } from "@/lib/bank/reply";
import { MemoryBankStore } from "@/lib/bank/store";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { profile } from "./helpers";

const paid = (name: string, amount: string, id: string) =>
  `Payment made for GHS ${amount} to ${name} Current Balance: GHS 1512.11 . Available Balance: GHS 1512.11. Reference: . Transaction ID: ${id}. Fee charged: GHS0.00`;

async function setup() {
  const store = new MemoryFinanceStore();
  const bank = new MemoryBankStore();
  const owner = profile(42, { preferredName: "Hans" });
  let sequence = 0;
  const ingest = {
    bank,
    ledger: store,
    now: new Date("2026-10-31T05:16:00.000Z"),
    createId: () => `7a1b2c3d-4444-4444-8444-${String(++sequence).padStart(12, "0")}`,
  };
  await ingestBankText(ingest, owner, paid("ELLEN OHENEWA OBENG-DARKO", "22.50", "92694674830"), { channel: "mac" });
  await ingestBankText(ingest, owner, paid("KOFI BOATENG", "40.00", "92694674831"), { channel: "mac" });
  return { ingest, owner, bank, store };
}

describe("answer buttons in the web chat", () => {
  it("offers the payment just asked about as tappable choices", async () => {
    const { ingest, owner } = await setup();
    expect(await currentQuestion(ingest, owner)).toBeNull();
    const asked = await askNext(ingest, owner);
    const current = await currentQuestion(ingest, owner);
    expect(current?.message.id).toBe(asked?.id);
    const labels = chatChoices(current?.buttons).flat().map((choice) => choice.label);
    expect(labels).toContain("Transport");
    expect(labels).toContain("Skip");
  });

  it("files a tapped choice without the model and asks the next one", async () => {
    const { ingest, owner, store } = await setup();
    await askNext(ingest, owner);
    const transport = chatChoices((await currentQuestion(ingest, owner))?.buttons)
      .flat()
      .find((choice) => choice.label === "Transport");
    expect(chatChoiceSchema.safeParse({ choice: transport?.choice, clientId: "6f1b2c3d-4444-4444-8444-000000000001" }).success).toBe(true);
    const chosen = await chooseLabel(ingest, owner, transport!.choice!);
    expect(chosen?.said).toBe("Transport");
    expect(chosen?.reply.text).toMatch(/^✓ .*Transport/);
    expect(chosen?.reply.text).toContain("Kofi Boateng");
    expect(chosen?.reply.buttons?.length).toBeGreaterThan(0);
    const filed = (await store.listTransactions(owner.profileId)).filter((item) => item.category === "Transport");
    expect(filed).toHaveLength(1);
  });

  it("turns the review link into a page on the site and drops other buttons", () => {
    expect(
      chatChoices([
        [{ text: "Food", callbackData: "b:7a1b2c3d-4444-4444-8444-000000000001:c0" }, { text: "Confirm", callbackData: "c:abc" }],
        [{ text: "Review all 3 on the web", url: "https://alfred.example/review" }],
      ]),
    ).toEqual([
      [{ label: "Food", choice: "b:7a1b2c3d-4444-4444-8444-000000000001:c0" }],
      [{ label: "Review all 3 on the web", href: "/review" }],
    ]);
  });
});
