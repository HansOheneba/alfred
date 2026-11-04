import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatPanel, createOwnedChatThreadRefresh, PaymentReplyContext } from "@/app/chat/chat-panel";
import { capturePaymentChatEntry, linkedPaymentReplyContext } from "@/app/chat/payment-link";
import type { ChatChoice } from "@/lib/accounts/chat-choices";
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
    expect(html).toContain("Ask something else");
    expect(html).not.toContain("Start a new topic");
    const ordinary = renderToStaticMarkup(createElement(ChatPanel, { ownerId: "fictional-owner", name: "Sample", initialMessages: [row("1", "assistant")] }));
    expect(ordinary).not.toContain("Ask something else");
  });
  it("preserves an explicit new-topic choice for refreshed retries", async () => {
    const log = new MemoryMessageLog();
    const saved = await log.append({ ownerId: "fictional-owner", role: "user", channel: "web", body: "Fictional unrelated request", clientId: "sample-new-topic", newTopic: true });
    expect(toThreadMessage(saved).newTopic).toBe(true);
    expect((await log.listByClientId("fictional-owner", "sample-new-topic"))[0].newTopic).toBe(true);
    expect(paymentReplyContext([toThreadMessage(saved), row("2", "assistant", newer)], "sample-new-topic")).toBeUndefined();
  });

  it("keeps every category, alternative answer and legitimate navigation link in the same wrapping chip group", () => {
    const initialChoices: ChatChoice[][] = [
      [{ label: "My own accounts", choice: `b:${first.bankMessageId}:r` }],
      [{ label: "Salary", choice: `b:${first.bankMessageId}:c0` }, { label: "Lent to me", choice: `b:${first.bankMessageId}:l` }, { label: "From investment", choice: `b:${first.bankMessageId}:i` }],
      [{ label: "All payments", href: "/accounts" }, { label: "My goals", href: "/settings#goals" }],
    ];
    const html = renderToStaticMarkup(createElement(ChatPanel, { ownerId: "fictional-owner", name: "Sample", initialMessages: [row("1", "assistant", first)], initialChoices }));
    for (const item of initialChoices.flat()) {
      const tag = item.href === undefined ? "button" : "a";
      const control = [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, "g"))].find(match => match[2].includes(item.label));
      expect(control?.[1]).toContain('class="alfred-chat-answer-chip"');
    }
    expect(html).toContain('href="/accounts"');
    expect(html).toContain('href="/settings#goals"');
    expect(html).toContain('data-kind="suggested"');
    expect(html).not.toContain("alfred-chat-answers-more");
    expect(html.indexOf("My own accounts")).toBeLessThan(html.indexOf("Salary"));
    expect(html.indexOf("Lent to me")).toBeLessThan(html.indexOf("From investment"));
  });

  it("makes the unrelated-chat action reversible without dismissing a pending payment", () => {
    const pending = renderToStaticMarkup(createElement(PaymentReplyContext, { newTopic: true, pending: true, busy: false, onChange: () => undefined }));
    expect(pending).toContain("This payment stays pending while we talk about something else.");
    expect(pending).toContain("Back to this payment");
    expect(pending).toContain('class="alfred-chat-answer-chip"');
    expect(pending).not.toContain("Start a new topic");
    const closed = renderToStaticMarkup(createElement(PaymentReplyContext, { newTopic: true, pending: false, busy: false, onChange: () => undefined }));
    expect(closed).not.toContain("stays pending");
    expect(closed).toContain("Your next message is about something else.");
    const sending = renderToStaticMarkup(createElement(PaymentReplyContext, { newTopic: false, pending: true, busy: true, onChange: () => undefined }));
    expect(sending).toContain('disabled=""');
    expect(sending).toContain("Ask something else");
  });

  it("freezes an ordinary displayed alert during Ask/Back even if a newer alert arrives", async () => {
    const displayed = row("1", "assistant", first), before = JSON.stringify(displayed);
    const selected = capturePaymentChatEntry([displayed], null);
    expect(selected?.state).toBe("ready");
    if (selected?.state !== "ready") throw Error("Expected a fictional payment boundary");
    const interleaved = [displayed, row("2", "assistant", newer)];
    expect(capturePaymentChatEntry(interleaved, selected)).toBe(selected);
    expect(linkedPaymentReplyContext(interleaved, undefined, selected.message.paymentNotice)).toEqual(first);
    const publish = vi.fn(), request = vi.fn(async () => Response.json({ ok: true, ownerId: "fictional-owner", messages: interleaved, choices: [], paymentEntry: selected }));
    // Back uses the captured locator, not the latest alert's locator.
    await createOwnedChatThreadRefresh("fictional-owner", publish, request, selected.bankMessageId).refresh();
    expect(request).toHaveBeenCalledExactlyOnceWith(`/api/chat?payment=${first.bankMessageId}`, expect.objectContaining({ cache: "no-store", credentials: "same-origin" }));
    expect(publish.mock.calls[0][0].paymentEntry.message.paymentNotice).toEqual(first);
    expect(JSON.stringify(displayed)).toBe(before);
  });
});
