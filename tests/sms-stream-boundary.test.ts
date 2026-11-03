import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "@/lib/config";

const mocks = vi.hoisted(() => ({ ownerForToken: vi.fn(), ingestBankMessages: vi.fn(), query: vi.fn() }));
vi.mock("@/lib/bank/service", () => ({ ownerForToken: mocks.ownerForToken, ingestBankMessages: mocks.ingestBankMessages, announceWhenQuiet: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: mocks.query }));
vi.mock("@/lib/env", () => ({ getDatabaseSettings: () => ({ projectRef: "fixture" }) }));
vi.mock("@/lib/security/db-rate-limit", () => ({ DbRateLimiter: class { async allow() { return true; } } }));

import { POST } from "@/app/api/ingest/sms/route";

const encoder = new TextEncoder();
const privateFixture = "FICTIONAL_PRIVATE_VALUE_DO_NOT_REFLECT";
function request(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  const cancel = vi.fn();
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next === chunks.length) controller.close();
      else controller.enqueue(chunks[next++]);
    },
    cancel,
  }, { highWaterMark: 0 });
  const init: RequestInit & { duplex: "half" } = { method: "POST", headers: { authorization: "Bearer alf_fictional_only", ...headers }, body, duplex: "half" };
  return { request: new Request("https://alfred.test/api/ingest/sms", init), cancel };
}
function textRequest(text: string, headers: Record<string, string> = {}) {
  return request([encoder.encode(text)], headers);
}
function wrapped(depth: number): string {
  let result = '{"text":"Fictional payment GHS 5"}';
  for (let index = 0; index < depth; index += 1) result = `{"wrapper":${result}}`;
  return result;
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.ownerForToken.mockResolvedValue({ profileId: "fixture-owner" });
  mocks.ingestBankMessages.mockResolvedValue({ outcomes: [], duplicates: 0, found: 1 });
  mocks.query.mockResolvedValue([]);
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe("SMS stream byte boundary", () => {
  it.each([undefined, "1", "not-a-size", "-1"])("rejects actual oversized bytes despite declared length %s", async (length) => {
    const headers: Record<string, string> = length === undefined ? {} : { "content-length": length };
    const input = request([new Uint8Array(LIMITS.maxBodyBytes), encoder.encode("x"), encoder.encode(privateFixture)], headers);
    const response = await POST(input.request);
    expect(response.status).toBe(413);
    expect(input.cancel).toHaveBeenCalledOnce();
    expect(mocks.ownerForToken).not.toHaveBeenCalled();
    expect(mocks.ingestBankMessages).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain(privateFixture);
  });

  it("cancels a declared oversized stream without starting account lookup", async () => {
    const input = textRequest(privateFixture, { "content-length": String(LIMITS.maxBodyBytes + 1) });
    expect((await POST(input.request)).status).toBe(413);
    expect(input.cancel).toHaveBeenCalledOnce();
    expect(mocks.ownerForToken).not.toHaveBeenCalled();
  });

  it("accepts exactly the actual byte limit while retaining the existing text-character limit", async () => {
    const input = textRequest("x".repeat(LIMITS.maxBodyBytes));
    expect((await POST(input.request)).status).toBe(200);
    expect(input.cancel).not.toHaveBeenCalled();
    expect(mocks.ingestBankMessages.mock.calls[0][2]).toHaveLength(4000);
  });

  it("counts UTF-8 bytes and decodes a character split between chunks", async () => {
    const bytes = encoder.encode("é".repeat(LIMITS.maxBodyBytes / 2));
    expect(bytes.byteLength).toBe(LIMITS.maxBodyBytes);
    const input = request([bytes.slice(0, 1), bytes.slice(1, 19), bytes.slice(19)]);
    expect((await POST(input.request)).status).toBe(200);
    expect(mocks.ingestBankMessages.mock.calls[0][2]).toBe("é".repeat(4000));
    const oversized = request([bytes, encoder.encode("x")], { "content-length": "1" });
    expect((await POST(oversized.request)).status).toBe(413);
    expect(oversized.cancel).toHaveBeenCalledOnce();
  });

  it("rejects malformed UTF-8 without interpreting replacement characters", async () => {
    const input = request([new Uint8Array([0xff])]);
    expect((await POST(input.request)).status).toBe(400);
    expect(input.cancel).toHaveBeenCalledOnce();
    expect(mocks.ownerForToken).not.toHaveBeenCalled();
  });

  it("rejects a truncated final UTF-8 character", async () => {
    expect((await POST(request([new Uint8Array([0xc3])]).request)).status).toBe(400);
    expect(mocks.ownerForToken).not.toHaveBeenCalled();
  });

  it("bounds work for a stream that produces only empty chunks", async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls += 1; controller.enqueue(new Uint8Array()); }, cancel }, { highWaterMark: 0 });
    const init: RequestInit & { duplex: "half" } = { method: "POST", headers: { authorization: "Bearer alf_fictional_only" }, body, duplex: "half" };
    expect((await POST(new Request("https://alfred.test/api/ingest/sms", init))).status).toBe(400);
    expect(cancel).toHaveBeenCalledOnce();
    expect(pulls).toBeLessThanOrEqual(LIMITS.maxBodyBytes + 2);
    expect(mocks.ownerForToken).not.toHaveBeenCalled();
  });

  it("does not reflect a stream failure's private error details", async () => {
    const body = new ReadableStream({ pull(controller) { controller.error(new Error(privateFixture)); } });
    const init: RequestInit & { duplex: "half" } = { method: "POST", headers: { authorization: "Bearer alf_fictional_only" }, body, duplex: "half" };
    const response = await POST(new Request("https://alfred.test/api/ingest/sms", init));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(privateFixture);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(privateFixture);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(privateFixture);
    expect(mocks.ownerForToken).not.toHaveBeenCalled();
  });
});

describe("bounded Shortcut JSON lookup and rejection privacy", () => {
  it("keeps reasonable nested Shortcut wrappers working", async () => {
    expect((await POST(textRequest(wrapped(8)).request)).status).toBe(200);
    expect(mocks.ingestBankMessages.mock.calls[0][2]).toBe("Fictional payment GHS 5");
  });

  it.each([9, 5000])("rejects a wrapper depth of %s before owner lookup or recursion", async (depth) => {
    const response = await POST(textRequest(wrapped(depth)).request);
    expect(response.status).toBe(400);
    expect(mocks.ownerForToken).not.toHaveBeenCalled();
    expect(mocks.ingestBankMessages).not.toHaveBeenCalled();
  });

  it("bounds wide JSON traversal even when a matching text field appears first", async () => {
    const base = { text: "Fictional payment GHS 5", ...Object.fromEntries(Array.from({ length: 511 }, (_, index) => [`field${index}`, null])) };
    expect((await POST(textRequest(JSON.stringify(base)).request)).status).toBe(200);
    vi.clearAllMocks();
    expect((await POST(textRequest(JSON.stringify({ ...base, extra: null })).request)).status).toBe(400);
    expect(mocks.ownerForToken).not.toHaveBeenCalled();
  });

  it("rejects excessive depth inside an unused array wrapper too", async () => {
    let nested: unknown = null;
    for (let depth = 0; depth < 10; depth += 1) nested = [nested];
    const response = await POST(textRequest(JSON.stringify({ text: "Fictional payment GHS 5", extra: nested })).request);
    expect(response.status).toBe(400);
    expect(mocks.ownerForToken).not.toHaveBeenCalled();
  });

  it("does not log private header values, arbitrary JSON key names, sender or body values", async () => {
    const input = textRequest(JSON.stringify({ text: "", sender: privateFixture, [privateFixture]: privateFixture }), {
      "content-type": `application/json; private=${privateFixture}`,
      "content-length": privateFixture,
      "user-agent": privateFixture,
    });
    const response = await POST(input.request);
    expect(response.status).toBe(400);
    const logs = JSON.stringify(vi.mocked(console.info).mock.calls);
    expect(logs).toContain('text,sender');
    expect(logs).not.toContain(privateFixture);
    expect(logs).not.toContain("alf_fictional_only");
    expect(await response.text()).not.toContain(privateFixture);
  });
});
