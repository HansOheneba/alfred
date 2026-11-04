import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTransferChatSample, TransferChatPreview } from "@/app/preview/automations/transfer/preview";
import { automationPreviewAllowed, automationPreviewBypassesAuth } from "@/lib/preview/access";
import { paymentQuestionPreviewSamples } from "@/app/preview/automations/transfer/fixtures";
import { ChatPanel } from "@/app/chat/chat-panel";
import { createOwnedChatThreadRefresh } from "@/app/chat/chat-panel";

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

  it("prepares real incoming/outgoing question choices and keeps all sample answers inside the closed transport", async () => {
    const network = vi.fn(() => { throw Error("The fictional questions must not contact a live service"); });
    vi.stubGlobal("fetch", network);
    const ordinarySamples = await paymentQuestionPreviewSamples();
    expect(ordinarySamples.map(item => item.state)).toEqual(["incoming", "outgoing"]);
    for (const fixture of ordinarySamples) {
      const sample = createTransferChatSample(fixture.state, fixture);
      const labels = sample.choices.flat().map(item => item.label);
      expect(labels).not.toContain("Skip");
      expect(labels).toContain(fixture.state === "incoming" ? "From investment" : "Investment");
      expect(fixture.body).toMatch(fixture.state === "incoming" ? /money[- ]in|incoming|received/i : /money[- ]out|outgoing|sent/i);
      const html = renderToStaticMarkup(createElement(ChatPanel, { ownerId: "fictional-transfer-preview", name: "Sample", initialMessages: sample.messages, initialChoices: sample.choices, initialPaymentEntry: sample.entry, initialPaymentTarget: sample.entry.state === "ready" ? sample.entry.bankMessageId : null, requestData: sample.request }));
      expect(html).toContain("Ask something else");
      expect(html).not.toContain("alfred-chat-answers-more");
      for (const item of sample.choices.flat()) {
        if (!item.choice) continue;
        const result = await (await sample.request("/api/chat", { method: "POST", body: JSON.stringify({ choice: item.choice, clientId: `sample-${item.choice}` }) })).json();
        expect(result.ledgerChanged).toBe(false);
        expect(result.messages.at(-1).text).toContain("Nothing was saved here");
      }
    }
    expect(network).not.toHaveBeenCalled();
  });

  it("uses the real progressive controller for delayed history and a failed-source/manual-retry sample", async () => {
    vi.useFakeTimers();
    try {
      const network = vi.fn(() => { throw Error("The loading samples must never contact a network service"); });
      vi.stubGlobal("fetch", network);
      const incoming = (await paymentQuestionPreviewSamples()).find(item => item.state === "incoming")!;
      const slow = createTransferChatSample("slow-history", incoming), progress = vi.fn(), publish = vi.fn();
      const controller = createOwnedChatThreadRefresh("fictional-transfer-preview", publish, slow.request, "11111111-1111-4111-8111-111111111111", { progressive: true, onProgress: progress, timeoutMs: 100 });
      const pending = controller.refresh(); await vi.advanceTimersByTimeAsync(1);
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ part: "payment", paymentEntry: expect.objectContaining({ state: "ready" }) }));
      await vi.advanceTimersByTimeAsync(100); await pending;
      expect(progress).toHaveBeenCalledWith(expect.objectContaining({ part: "history", state: "error" }));
      const failed = createTransferChatSample("retry-payment", incoming), retried = vi.fn();
      const retry = createOwnedChatThreadRefresh("fictional-transfer-preview", retried, failed.request, "11111111-1111-4111-8111-111111111111", { progressive: true, onProgress: progress });
      await retry.refresh();
      expect(retried.mock.calls.some(call => call[0].part === "payment")).toBe(false);
      await retry.refresh();
      expect(retried).toHaveBeenCalledWith(expect.objectContaining({ part: "payment", paymentEntry: expect.objectContaining({ bankMessageId: "11111111-1111-4111-8111-111111111111" }) }));
      expect(network).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
