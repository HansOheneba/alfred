import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatPanel } from "@/app/chat/chat-panel";
import { MemoryMessageLog } from "@/lib/accounts/messages";
import { mergeThread, paymentReplyContext, toThreadMessage, type ThreadMessage } from "@/lib/accounts/thread";

const first = { bankMessageId: "11111111-1111-4111-8111-111111111111", requiresPurpose: true };
const newer = { bankMessageId: "22222222-2222-4222-8222-222222222222", requiresPurpose: true };
const row = (id: string, role: "user" | "assistant", paymentNotice?: typeof first): ThreadMessage => ({ id, role, text: "Fictional only", channel: "web", createdAt: `2026-11-03T12:00:0${id}Z`, clientId: `sample-turn-${id}`, paymentNotice });

describe("payment question client binding", () => {
  it("roundtrips exact notice context through saved history and thread refresh", async () => {
    const log = new MemoryMessageLog();
    const saved = await log.append({ ownerId: "fictional-owner", role: "assistant", channel: "web", body: "Fictional purpose question", paymentNotice: first });
    const history = await log.listRecent("fictional-owner", 10);
    expect(toThreadMessage(saved).paymentNotice).toEqual(first);
    expect(mergeThread([], history.map(toThreadMessage))[0].paymentNotice).toEqual(first);
    expect(await log.listRecent("other-owner", 10)).toEqual([]);
  });
  it("binds new replies to the latest displayed assistant, including a known-purpose acknowledgement", () => {
    expect(paymentReplyContext([row("1", "assistant", first)])).toEqual(first);
    expect(paymentReplyContext([row("1", "assistant", first), row("2", "assistant", { ...newer, requiresPurpose: false })])).toEqual({ ...newer, requiresPurpose: false });
    expect(paymentReplyContext([row("1", "assistant", first), row("2", "assistant")])).toBeUndefined();
  });
  it("preserves the original displayed question on retry after a new notice", () => {
    const history = [row("1", "assistant", first), row("2", "user", first), row("3", "assistant", newer)];
    expect(paymentReplyContext(history, "sample-turn-2")).toEqual(first);
  });
  it("does not attach a newly arrived question to a retry that originally had no notice", () => {
    expect(paymentReplyContext([row("1", "assistant"), row("2", "user"), row("3", "assistant", newer)], "sample-turn-2")).toBeUndefined();
  });
  it("shows the reply target and an explicit way to begin an unrelated request", () => {
    const html = renderToStaticMarkup(createElement(ChatPanel, { ownerId: "fictional-owner", name: "Sample", initialMessages: [row("1", "assistant", first)] }));
    expect(html).toContain("Replying about this payment alert.");
    expect(html).toContain("Start a new topic");
    const ordinary = renderToStaticMarkup(createElement(ChatPanel, { ownerId: "fictional-owner", name: "Sample", initialMessages: [row("1", "assistant")] }));
    expect(ordinary).not.toContain("Start a new topic");
  });
  it("preserves an explicit new-topic choice for refreshed retries", async () => {
    const log = new MemoryMessageLog();
    const saved = await log.append({ ownerId: "fictional-owner", role: "user", channel: "web", body: "Fictional unrelated request", clientId: "sample-new-topic", newTopic: true });
    expect(toThreadMessage(saved).newTopic).toBe(true);
    expect((await log.listByClientId("fictional-owner", "sample-new-topic"))[0].newTopic).toBe(true);
    expect(paymentReplyContext([toThreadMessage(saved), row("2", "assistant", newer)], "sample-new-topic")).toBeUndefined();
  });
});
