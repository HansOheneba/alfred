"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ChatPanel } from "@/app/chat/chat-panel";
import type { PaymentChatEntry } from "@/app/chat/payment-entry";
import { buttonClassName } from "@/app/components/button-styles";
import type { ChatMessageRecord } from "@/lib/accounts/messages";
import { toThreadMessage } from "@/lib/accounts/thread";
import type { OwnTransferNotice } from "@/lib/bank/own-transfers";
import { transferMention } from "@/lib/bank/transfer-mention";
import type { PaymentQuestionSample } from "./fixtures";

const ownerId = "fictional-transfer-preview";
const bankId = "11111111-1111-4111-8111-111111111111";
type SampleState = "paired" | "candidate" | "incoming" | "outgoing" | "slow-history" | "retry-payment" | "proposal";

/** Closed sample transport. No branch delegates to fetch, a real account, a
 * notification provider, classification storage or the Messages collector. */
export function createTransferChatSample(state: SampleState, ordinary?: PaymentQuestionSample) {
  const questionState = state === "slow-history" || state === "retry-payment" || state === "proposal" ? "incoming" : state;
  const transferState = state === "paired" ? "paired" : "candidate";
  const transfer: OwnTransferNotice = {
    state: transferState, ownerId, pairId: "sample-pair", outgoingBankMessageId: bankId,
    incomingBankMessageId: "22222222-2222-4222-8222-222222222222", amount: "1.00", currency: "GHS",
    fromAccount: { id: "sample-hubtel", label: "Hubtel wallet" }, toAccount: { id: "sample-momo", label: "MTN MoMo" }, evidenceFingerprint: "fictional-only",
  };
  const notice = questionState === "incoming" || questionState === "outgoing"
    ? ordinary?.state === questionState ? ordinary : null
    : transferMention({ id: bankId, ownerId, direction: "out", amount: "1.00", currency: "GHS", kind: state === "paired" ? "transfer_own" : "payment", status: state === "paired" ? "transfer" : "needs_label", transactionId: null }, transfer);
  if (!notice) throw Error("The sample conversation could not be prepared.");
  const choices = ordinary?.state === questionState ? ordinary.choices : [];
  const message: ChatMessageRecord = { id: "sample-transfer-notice", role: "assistant", channel: "web", body: notice.body, createdAt: "2026-11-04T11:09:00.000Z", clientId: "sample-transfer-notice", intent: questionState === "incoming" ? "automation:incoming-payment" : "automation:outgoing-payment", paymentNotice: { bankMessageId: bankId, requiresPurpose: notice.requiresPurpose }, ledgerChanged: false };
  const entry: PaymentChatEntry = { state: "ready", bankMessageId: bankId, sourceVersion: `sample-${state}`, message };
  const messages = [message];
  const present = (row: ChatMessageRecord) => ({ ...row, text: row.body });
  let sequence = 0;
  let paymentReads = 0;
  const request: typeof fetch = async (input, options) => {
    const path = String(input).split("?")[0];
    if (path === "/api/chat" && (!options?.method || options.method === "GET")) {
      const url = new URL(String(input), "https://fictional.example"), part = url.searchParams.get("part");
      const selected = url.searchParams.get("payment") === bankId;
      if (part === "history" && state === "slow-history") return new Promise<Response>((_resolve, reject) => { const stop = () => reject(new Error("Sample history read stopped.")); if (options?.signal?.aborted) stop(); else options?.signal?.addEventListener("abort", stop, { once: true }); });
      if (part === "payment") {
        paymentReads += 1;
        if (state === "retry-payment" && paymentReads === 1) return Response.json({ ok: false, text: "The sample payment could not open." }, { status: 503 });
        return Response.json({ ok: true, ownerId, messages: [present(message)], paymentEntry: entry, part });
      }
      if (part === "history") return Response.json({ ok: true, ownerId, messages: state === "retry-payment" && paymentReads <= 1 ? [] : messages.map(present), part });
      if (part === "choices") return Response.json({ ok: true, ownerId, messages: [], choices, choiceTarget: selected ? bankId : null, sourceVersion: entry.sourceVersion, part });
      return Response.json({ ok: true, ownerId, messages: messages.map(present), choices: selected || messages.length === 1 ? choices : [], ...(selected ? { paymentEntry: entry } : {}) });
    }
    if (path === "/api/chat" && options?.method === "POST") {
      let body: { text?: string; choice?: string; clientId?: string; decision?: "confirm" | "cancel" };
      try { body = JSON.parse(String(options.body)); } catch { return Response.json({ ok: false, text: "Try a short sample reply." }, { status: 400 }); }
      if (body.decision) {
        sequence += 1;
        const reply: ChatMessageRecord = { id: `sample-decision-${sequence}`, role: "assistant", channel: "web", body: body.decision === "confirm" ? "Sample only: on your account this would save both. Nothing was saved here." : "Cancelled. Nothing was changed.", clientId: body.clientId ?? `sample-decision-${sequence}`, createdAt: new Date(Date.parse("2026-11-04T11:10:00.000Z") + sequence * 1000).toISOString(), ledgerChanged: false };
        messages.push(reply);
        return Response.json({ ok: true, messages: [present(reply)], choices: body.decision === "cancel" ? choices : [], ledgerChanged: false });
      }
      const answer = body.choice ? choices.flat().find(item => item.choice === body.choice)?.label : body.text?.trim();
      if (!answer) return Response.json({ ok: false, text: "Try a short sample reply." }, { status: 400 });
      sequence += 1;
      const clientId = body.clientId ?? `sample-turn-${sequence}`;
      const createdAt = new Date(Date.parse("2026-11-04T11:10:00.000Z") + sequence * 1000).toISOString();
      const incoming: ChatMessageRecord[] = [
        { id: `sample-user-${sequence}`, role: "user", channel: "web", body: answer, clientId, createdAt },
        { id: `sample-answer-${sequence}`, role: "assistant", channel: "web", body: "This is a sample conversation only. On your account, I'd check both alerts before linking or changing anything. Nothing was saved here.", clientId, createdAt, ledgerChanged: false },
      ];
      if (state === "proposal") {
        // Alfred's reading of a top-up that paid for a subscription, waiting for a yes. The payment's
        // answer chips are still sent, as the real thread does, so the preview shows they stay hidden.
        incoming[1] = { ...incoming[1], body: "Here's how I read those:\n• GH₵1,300.00 onto your GCB card · Tue 3 Nov: your own money moving between your accounts, not income or spending\n• GH₵1,307.48 on your GCB card · Tue 3 Nov: Subscriptions (Claude subscription)\n\nSave this? Nothing changes until you confirm." };
        messages.push(...incoming);
        return Response.json({ ok: true, messages: incoming.map(present), actionId: "sample-proposal", choices, ledgerChanged: false });
      }
      messages.push(...incoming);
      return Response.json({ ok: true, messages: incoming.map(present), choices: [], ledgerChanged: false });
    }
    if (path === "/api/chat/empty") return Response.json({ ok: true, ownerId, financialsEmpty: false });
    return Response.json({ ok: false, text: "This sample doesn't open accounts, upload images or load your financial records." }, { status: 400 });
  };
  return { entry, messages: [toThreadMessage(message)], choices, request, startsLoading: state === "slow-history" || state === "retry-payment" };
}

export function TransferChatPreview({ ordinarySamples = [] }: { ordinarySamples?: PaymentQuestionSample[] }) {
  const [state, setState] = useState<SampleState>("paired");
  const sample = useMemo(() => createTransferChatSample(state, ordinarySamples.find(item => item.state === (state === "slow-history" || state === "retry-payment" || state === "proposal" ? "incoming" : state))), [state, ordinarySamples]);
  return <main className="flex h-dvh min-h-0 flex-col bg-bg">
    <header className="shrink-0 border-b border-line bg-surface px-4 py-3">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
        <div><p className="text-xs text-muted">Demo · sample data only</p><h1 className="mt-1 text-base font-medium">Your transfer, in Chat</h1></div>
        <Link href="/preview/automations" className="text-sm text-accent underline underline-offset-4">Back to Automations</Link>
      </div>
      <div className="mx-auto mt-3 flex max-w-5xl flex-wrap gap-2" role="group" aria-label="Sample transfer situations">
        <button type="button" aria-pressed={state === "paired"} className={buttonClassName({ variant: state === "paired" ? "primary" : "secondary", size: "sm" })} onClick={() => setState("paired")}>Recognised transfer</button>
        <button type="button" aria-pressed={state === "candidate"} className={buttonClassName({ variant: state === "candidate" ? "primary" : "secondary", size: "sm" })} onClick={() => setState("candidate")}>Needs a quick answer</button>
        {ordinarySamples.map(item => <button key={item.state} type="button" aria-pressed={state === item.state} className={buttonClassName({ variant: state === item.state ? "primary" : "secondary", size: "sm" })} onClick={() => setState(item.state)}>{item.state === "incoming" ? "Incoming payment" : "Outgoing payment"}</button>)}
        {ordinarySamples.length ? <><button type="button" aria-pressed={state === "slow-history"} className={buttonClassName({ variant: state === "slow-history" ? "primary" : "secondary", size: "sm" })} onClick={() => setState("slow-history")}>Payment first</button><button type="button" aria-pressed={state === "retry-payment"} className={buttonClassName({ variant: state === "retry-payment" ? "primary" : "secondary", size: "sm" })} onClick={() => setState("retry-payment")}>Retry a payment</button><button type="button" aria-pressed={state === "proposal"} className={buttonClassName({ variant: state === "proposal" ? "primary" : "secondary", size: "sm" })} onClick={() => setState("proposal")}>Alfred proposes</button></> : null}
      </div>
      <p className="mx-auto mt-2 max-w-5xl text-xs text-muted">Try a sample reply. This preview never changes accounts or sends notifications.</p>
    </header>
    <ChatPanel key={state} ownerId={ownerId} name="Sample" initialMessages={sample.startsLoading ? [] : sample.messages} initialChoices={sample.startsLoading ? [] : sample.choices} initialPaymentEntry={sample.startsLoading ? null : sample.entry} initialPaymentTarget={bankId} requestData={sample.request} financialsEmpty={false} loadInitialThread={sample.startsLoading} />
  </main>;
}
