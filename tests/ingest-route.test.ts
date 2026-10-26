import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/ingest/sms/route";

function logged(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

describe("SMS ingest rejections", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a missing key", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const response = await POST(new Request("https://alfred.test/api/ingest/sms", { method: "POST", body: "GHS 5.00" }));
    expect(response.status).toBe(401);
    expect(logged(info)).toEqual([expect.objectContaining({ event: "sms_ingest_rejected", reason: "missing_key" })]);
  });

  it("logs the shape of an empty body without any message text", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const response = await POST(
      new Request("https://alfred.test/api/ingest/sms", {
        method: "POST",
        headers: { authorization: "Bearer alf_test", "content-type": "text/plain; charset=utf-8" },
        body: "   ",
      }),
    );
    expect(response.status).toBe(400);
    expect(logged(info)).toEqual([
      expect.objectContaining({
        event: "sms_ingest_rejected",
        reason: "no_text",
        contentType: "text/plain; charset=utf-8",
        bodyBytes: 3,
        blankBody: true,
      }),
    ]);
  });

  it("logs JSON key names but not their values", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const response = await POST(
      new Request("https://alfred.test/api/ingest/sms", {
        method: "POST",
        headers: { authorization: "Bearer alf_test", "content-type": "application/json" },
        body: JSON.stringify({ text: "", sender: "MobileMoney GHS secret" }),
      }),
    );
    expect(response.status).toBe(400);
    const [entry] = logged(info);
    expect(entry).toMatchObject({ reason: "no_text", jsonKeys: "text,sender", blankBody: false });
    expect(JSON.stringify(entry)).not.toContain("MobileMoney");
  });
});
