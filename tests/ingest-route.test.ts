import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ownerForToken: vi.fn(),
  ingestBankMessages: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/bank/service", () => ({ ownerForToken: mocks.ownerForToken, ingestBankMessages: mocks.ingestBankMessages, announceWhenQuiet: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: mocks.query }));
vi.mock("@/lib/env", () => ({ getDatabaseSettings: () => ({ projectRef: "test" }) }));
vi.mock("@/lib/security/db-rate-limit", () => ({
  DbRateLimiter: class {
    async allow() {
      return true;
    }
  },
}));

import { POST } from "@/app/api/ingest/sms/route";

const KEY = { authorization: "Bearer alf_test" };

function logged(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

function send(body: string, headers: Record<string, string> = {}): Promise<Response> {
  return POST(new Request("https://alfred.test/api/ingest/sms", { method: "POST", headers: { ...KEY, ...headers }, body }));
}

describe("SMS ingest", () => {
  beforeEach(() => {
    mocks.ownerForToken.mockResolvedValue({ profileId: "owner-1" });
    mocks.ingestBankMessages.mockResolvedValue({ outcomes: [], duplicates: 0, found: 1 });
    mocks.query.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("logs a missing key", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const response = await POST(new Request("https://alfred.test/api/ingest/sms", { method: "POST", body: "GHS 5.00" }));
    expect(response.status).toBe(401);
    expect(logged(info)).toEqual([expect.objectContaining({ event: "sms_ingest_rejected", reason: "missing_key" })]);
  });

  it("checks the key before the body, so a bad key never counts as an empty ping", async () => {
    mocks.ownerForToken.mockResolvedValue(null);
    vi.spyOn(console, "info").mockImplementation(() => {});
    const response = await send("   ");
    expect(response.status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("remembers an empty ping and logs its shape without any message text", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const response = await send("   ", { "content-type": "text/plain; charset=utf-8" });
    expect(response.status).toBe(400);
    expect(logged(info)).toEqual([
      expect.objectContaining({ event: "sms_ingest_rejected", reason: "no_text", contentType: "text/plain; charset=utf-8", bodyBytes: 3, blankBody: true }),
    ]);
    expect(mocks.query).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("last_empty_at"), ["owner-1"]);
  });

  it("logs JSON key names but not their values", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const response = await send(JSON.stringify({ text: "", sender: "MobileMoney GHS secret" }), { "content-type": "application/json" });
    expect(response.status).toBe(400);
    const [entry] = logged(info);
    expect(entry).toMatchObject({ reason: "no_text", jsonKeys: "text,sender", blankBody: false });
    expect(JSON.stringify(entry)).not.toContain("MobileMoney");
  });

  it.each([
    ["plain text", "Payment made for GHS 5.00", {}],
    ["JSON with text", JSON.stringify({ text: "Payment made for GHS 5.00" }), { "content-type": "application/json" }],
    ["JSON with a capitalised Content key", JSON.stringify({ Content: "Payment made for GHS 5.00" }), {}],
    ["nested JSON", JSON.stringify({ message: { content: "Payment made for GHS 5.00" } }), {}],
    ["a form", "text=Payment+made+for+GHS+5.00", { "content-type": "application/x-www-form-urlencoded" }],
  ])("reads the message from %s", async (_label, body, headers) => {
    const response = await send(body, headers);
    expect(response.status).toBe(200);
    expect(mocks.ingestBankMessages).toHaveBeenCalledWith(expect.anything(), expect.anything(), "Payment made for GHS 5.00", expect.objectContaining({ channel: "shortcut" }));
  });

  it("files Mac relay texts under their own channel with the time they arrived", async () => {
    const at = new Date(Date.now() - 3_600_000).toISOString();
    await send(JSON.stringify({ text: "Payment made for GHS 5.00", sender: "MobileMoney", source: "mac", receivedAt: at }));
    expect(mocks.ingestBankMessages).toHaveBeenCalledWith(expect.anything(), expect.anything(), "Payment made for GHS 5.00", {
      channel: "mac",
      sender: "MobileMoney",
      receivedAt: new Date(at),
    });
  });

  it("ignores a received time in the future", async () => {
    await send(JSON.stringify({ text: "GHS 5.00", source: "mac", receivedAt: new Date(Date.now() + 86_400_000).toISOString() }));
    expect(mocks.ingestBankMessages.mock.calls[0][3].receivedAt).toBeUndefined();
  });
});
