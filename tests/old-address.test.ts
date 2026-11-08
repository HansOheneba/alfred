import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch as doesProxyMatch } from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";

import { DASHBOARD_URL } from "@/lib/config";
import { config, proxy } from "@/proxy";

const OLD = "alfred.hansopoku.com";
const visit = (path: string, host = OLD, method = "GET") => proxy(new NextRequest(`https://${host}${path}`, { method, headers: { host } }));

describe("the old address", () => {
  it("sends page visits to the same page on the new address", async () => {
    const response = await visit("/chat?payment=abc");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${DASHBOARD_URL}/chat?payment=abc`);
    expect((await visit("/")).headers.get("location")).toBe(`${DASHBOARD_URL}/`);
  });

  it("keeps answering the callers that don't follow redirects", async () => {
    for (const path of ["/api/collector/health", "/api/chat"]) expect((await visit(path)).headers.get("location")).toBeNull();
    expect((await visit("/settings", OLD, "POST")).headers.get("location")).toBeNull();
    for (const url of ["/api/ingest/sms", "/api/telegram/webhook", "/alfred-push-sw.js", "/sw.js"]) expect(doesProxyMatch({ config, url })).toBe(false);
  });

  it("leaves the new address alone", async () => {
    expect((await visit("/chat", new URL(DASHBOARD_URL).host)).headers.get("location")).toBeNull();
  });
});
