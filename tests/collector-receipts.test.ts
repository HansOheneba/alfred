import { describe, expect, it } from "vitest";
import { collectorPayloadHash, readCollectorEnvelope, storedCollectorReceipt } from "@/lib/bank/collector-receipts";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", receiptId = "11111111-1111-4111-8111-111111111111", eventId = "a".repeat(64);
const body = () => ({ protocol: 2, eventId, source: "mac", sender: "mobilemoney", receivedAt: "2026-11-06T21:20:01.000Z", text: "Fixture GHS 25 👩🏽‍💻 e\u0301" });
describe("content-free durable collector envelope", () => {
  it("shares an exact UTF8 fingerprint with the native fixture", () => {
    const input = body();
    expect(collectorPayloadHash(input.sender, input.receivedAt, input.text)).toBe("cc36e7193b022e3175fcc21d5aca36f8465f944d3bc3f8c1a1ce1f8e3a6090d7");
    expect(readCollectorEnvelope(JSON.stringify(input))).toEqual({ eventId, payloadHash: "cc36e7193b022e3175fcc21d5aca36f8465f944d3bc3f8c1a1ce1f8e3a6090d7" });
  });
  it("binds every exact transmitted field without trimming, normalizing or retaining contents", () => {
    const original = readCollectorEnvelope(JSON.stringify(body()))!;
    for (const patch of [{ text: body().text + " " }, { sender: "MobileMoney" }, { receivedAt: "2026-11-06T21:20:01Z" }, { text: body().text.normalize("NFC") }]) {
      expect(readCollectorEnvelope(JSON.stringify({ ...body(), ...patch }))?.payloadHash).not.toBe(original.payloadHash);
    }
    const receipt = storedCollectorReceipt(owner, original, receiptId);
    expect(JSON.stringify(receipt)).not.toContain("Fixture");
    expect(JSON.stringify(receipt)).not.toContain("mobilemoney");
    expect(receipt).toMatchObject({ version: 2, ownerId: owner, eventId, receiptId, disposition: "stored" });
    expect(storedCollectorReceipt(owner, original, receiptId, true).disposition).toBe("duplicate");
  });
  it.each([{ protocol: true }, { protocol: 1 }, { eventId: "source-guid" }, { source: "shortcut" }, { sender: "x".repeat(81) }, { sender: "name\u0000tail" }, { sender: "name\uD800tail" }, { text: "x".repeat(4001) }, { text: "😀".repeat(2001) }, { text: "Fictional \uD800" }, { text: "Fictional \uDC00" }, { text: " " }, { receivedAt: "invalid" }, { text: { nested: "not a protocol2 string" } }])("rejects malformed or oversized version2 fields without truncation: %j", (patch) => {
    expect(() => readCollectorEnvelope(JSON.stringify({ ...body(), ...patch }))).toThrow("Invalid collector envelope");
  });
  it("accepts a full 4000-unit message and keeps old Shortcut input independent", () => {
    expect(readCollectorEnvelope(JSON.stringify({ ...body(), text: "😀".repeat(2000) }))).not.toBeNull();
    expect(readCollectorEnvelope(JSON.stringify({ text: "Legacy synthetic input" }))).toBeNull();
    expect(readCollectorEnvelope("Legacy synthetic input")).toBeNull();
  });
});
