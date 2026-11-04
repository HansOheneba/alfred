import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPanel, createOwnedChatThreadRefresh } from "@/app/chat/chat-panel";
import { chatSubmissionReady } from "@/app/chat/payment-link";
import type { PaymentChatEntry } from "@/app/chat/payment-entry";

const ownerId = "fictional-owner", bank = "11111111-1111-4111-8111-111111111111";
const message = { id: "current-source", role: "assistant", text: "Current owned GH₵1.00 incoming alert.", channel: "web", createdAt: "2026-11-04T11:09:00Z", clientId: "bank_notice_fictional", paymentNotice: { bankMessageId: bank, requiresPurpose: true } };
const entry = { state: "ready", bankMessageId: bank, sourceVersion: "current-version", message: { ...message, body: message.text } };
const packet = (part: string) => ({ ok: true, ownerId, messages: part === "payment" ? [message] : [], ...(part === "payment" ? { paymentEntry: entry } : part === "choices" ? { choices: [[{ label: "Gift", choice: `b:${bank}:c2` }]], choiceTarget: bank, sourceVersion: "current-version" } : {}) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(() => vi.useRealTimers());

describe("progressive owner-bound Chat opening", () => {
  it("publishes the selected source and current choices before optional history, then bounds a hung read without retrying", async () => {
    vi.useFakeTimers();
    const publish = vi.fn(), progress = vi.fn(), history = deferred<Response>();
    const request = vi.fn((url: RequestInfo | URL, requestOptions?: RequestInit) => {
      if (requestOptions?.signal?.aborted) throw new Error("The sample request was cancelled.");
      const part = new URL(String(url), "https://fictional.example").searchParams.get("part")!;
      return part === "history" ? history.promise : Promise.resolve(Response.json(packet(part)));
    });
    const refresh = createOwnedChatThreadRefresh(ownerId, publish, request, bank, { progressive: true, onProgress: progress, timeoutMs: 100 });
    const pending = refresh.refresh();
    await vi.advanceTimersByTimeAsync(1);
    expect(publish.mock.calls.map(call => call[0].part)).toEqual(["payment", "choices"]);
    expect(publish.mock.calls[0][0].paymentEntry.bankMessageId).toBe(bank);
    expect(request).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(100); await pending;
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ part: "history", state: "error", text: expect.stringContaining("try again") }));
    expect(request).toHaveBeenCalledTimes(3);
    const historyOptions = request.mock.calls.find(call => String(call[0]).includes("part=history"))?.[1];
    expect(historyOptions?.signal?.aborted).toBe(true);
    history.resolve(Response.json({ ...packet("history"), messages: [{ ...message, id: "late-history" }] }));
    await vi.advanceTimersByTimeAsync(1);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("shows a source failure, skips its answer choices, and allows one explicit retry of the same target", async () => {
    vi.useFakeTimers();
    let failure = true;
    const publish = vi.fn(), progress = vi.fn();
    const request = vi.fn((url: RequestInfo | URL) => {
      const part = new URL(String(url), "https://fictional.example").searchParams.get("part")!;
      return failure && part === "payment" ? new Promise<Response>(() => undefined) : Promise.resolve(Response.json(packet(part)));
    });
    const refresh = createOwnedChatThreadRefresh(ownerId, publish, request, bank, { progressive: true, onProgress: progress, timeoutMs: 100 });
    const first = refresh.refresh(); await vi.advanceTimersByTimeAsync(101); await first;
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ part: "payment", state: "error" }));
    expect(request.mock.calls.some(call => String(call[0]).includes("part=choices"))).toBe(false);
    failure = false; await refresh.refresh();
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ paymentEntry: expect.objectContaining({ bankMessageId: bank }), part: "payment" }));
    expect(request.mock.calls.filter(call => String(call[0]).includes("part=payment")).every(call => String(call[0]).includes(`payment=${bank}`))).toBe(true);
  });

  it("discards another owner's payload, stale choices and cancelled late reads", async () => {
    const publish = vi.fn(), progress = vi.fn();
    const request = vi.fn(async (url: RequestInfo | URL) => {
      const part = new URL(String(url), "https://fictional.example").searchParams.get("part")!;
      return Response.json({ ...packet(part), ...(part === "choices" ? { sourceVersion: "older-version" } : {}) });
    });
    const refresh = createOwnedChatThreadRefresh(ownerId, publish, request, bank, { progressive: true, onProgress: progress });
    await refresh.refresh();
    expect(publish.mock.calls.some(call => call[0].part === "choices")).toBe(false);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ part: "choices", state: "error" }));
    request.mockImplementation(async () => Response.json({ ...packet("payment"), ownerId: "other-owner" }));
    publish.mockClear(); await refresh.refresh(); expect(publish).not.toHaveBeenCalled();
    const late = deferred<Response>(); request.mockImplementation(() => late.promise);
    const pending = refresh.refresh(); refresh.dispose(); await pending;
    late.resolve(Response.json(packet("payment"))); await Promise.resolve();
    expect(publish).not.toHaveBeenCalled();
  });

  it("bounds a stalled response body as well as a stalled fetch", async () => {
    vi.useFakeTimers(); const progress = vi.fn();
    const request = vi.fn(async () => ({ ok: true, json: () => new Promise(() => undefined) }) as Response);
    const refresh = createOwnedChatThreadRefresh(ownerId, vi.fn(), request, null, { onProgress: progress, timeoutMs: 30 });
    const pending = refresh.refresh(); await vi.advanceTimersByTimeAsync(31); await pending;
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ part: "thread", state: "error" }));
  });

  it("renders honest loading instead of a fake fresh welcome, and blocks a payment reply before its source is ready", () => {
    const html = renderToStaticMarkup(createElement(ChatPanel, { ownerId, name: "Sample", initialMessages: [], initialPaymentTarget: bank, loadInitialThread: true, financialsEmpty: null, initialQuestion: "yes" }));
    expect(html).toContain("Opening this payment"); expect(html).toContain("Loading your conversation");
    expect(html).not.toContain("A purchase, a payday");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Send"/);
    expect(html).toContain("Ask something else");
  });

  it("blocks unavailable or mismatched payment answers but keeps an explicit unrelated text usable", () => {
    const selected: PaymentChatEntry = { state: "ready", bankMessageId: bank, message: { id: "selected", role: "assistant", channel: "web", body: "Fictional only", createdAt: "2026-11-04T11:09:00Z", clientId: "selected" } };
    expect(chatSubmissionReady(bank, null, false, false)).toBe(false);
    expect(chatSubmissionReady(bank, { state: "unavailable" }, true, false)).toBe(false);
    expect(chatSubmissionReady(bank, { state: "unavailable" }, false, true)).toBe(true);
    expect(chatSubmissionReady(bank, selected, false, false)).toBe(true);
    expect(chatSubmissionReady("22222222-2222-4222-8222-222222222222", selected, true, false)).toBe(false);
    const html = renderToStaticMarkup(createElement(ChatPanel, { ownerId, name: "Sample", initialMessages: [], initialPaymentTarget: bank, initialPaymentEntry: { state: "unavailable" }, loadInitialThread: true, financialsEmpty: null, initialQuestion: "yes" }));
    expect(html).toContain("Try again"); expect(html).toContain("Ask something else");
    expect(html).not.toContain("Opening this payment");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Send"/);
  });
});
