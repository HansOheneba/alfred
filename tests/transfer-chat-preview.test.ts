import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTransferChatSample, TransferChatPreview } from "@/app/preview/automations/transfer/preview";
import { automationPreviewAllowed, automationPreviewBypassesAuth } from "@/lib/preview/access";

afterEach(() => vi.unstubAllGlobals());

describe("guarded sample transfer conversation", () => {
  it("renders the real Chat interface with a clear sample label and no movement modal", () => {
    const html = renderToStaticMarkup(createElement(TransferChatPreview));
    expect(html).toContain("Demo · sample data only");
    expect(html).toContain("GH₵1.00 transfer from Hubtel wallet to MTN MoMo");
    expect(html).toContain("Message Alfred");
    expect(html).toContain("Recognised transfer");
    expect(html).toContain("Needs a quick answer");
    expect(html).not.toContain("Movement details");
    expect(html).not.toContain("Save classification");
  });

  it.each(["paired", "candidate"] as const)("keeps all %s sample reads and replies local without real financial writes", async state => {
    const network = vi.fn(() => { throw Error("Sample transport must never use a network service"); });
    vi.stubGlobal("fetch", network);
    const sample = createTransferChatSample(state);
    const original = await (await sample.request("/api/chat?payment=11111111-1111-4111-8111-111111111111")).json();
    expect(original.ownerId).toBe("fictional-transfer-preview");
    expect(original.paymentEntry.message.paymentNotice.requiresPurpose).toBe(state === "candidate");
    expect(original.messages[0].text).toContain(state === "candidate" ? "Was this money moving between your own accounts?" : "I've linked both sides");
    for (const [index, text] of ["yes", "From my Hubtel wallet to my MTN MoMo"].entries()) {
      const reply = await (await sample.request("/api/chat", { method: "POST", body: JSON.stringify({ text, clientId: `fictional-reply-${index}` }) })).json();
      expect(reply.ledgerChanged).toBe(false);
      expect(reply.messages.at(-1).text).toContain("Nothing was saved here");
    }
    expect((await sample.request("/api/chat/image", { method: "POST" })).status).toBe(400);
    expect((await sample.request("/api/notifications/test", { method: "POST" })).status).toBe(400);
    expect((await sample.request("https://alfred.hansopoku.com/api/chat")).status).toBe(400);
    expect(network).not.toHaveBeenCalled();
  });

  it("opens only the exact read-only sample path outside production", () => {
    const path = "/preview/automations/transfer";
    expect(automationPreviewBypassesAuth(path, "GET", { NODE_ENV: "production", VERCEL_ENV: "preview" })).toBe(true);
    expect(automationPreviewBypassesAuth(path, "POST", { NODE_ENV: "production", VERCEL_ENV: "preview" })).toBe(false);
    expect(automationPreviewAllowed({ NODE_ENV: "production", VERCEL_ENV: "production", ALFRED_LOCAL_PREVIEW: "1" })).toBe(false);
    expect(automationPreviewBypassesAuth(path + "/private", "GET", { NODE_ENV: "test", ALFRED_LOCAL_PREVIEW: "1" })).toBe(false);
  });
});
