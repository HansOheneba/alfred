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

const ownerId = "fictional-transfer-preview";
const bankId = "11111111-1111-4111-8111-111111111111";
type SampleState = "paired" | "candidate";

/** Closed sample transport. No branch delegates to fetch, a real account, a
 * notification provider, classification storage or the Messages collector. */
export function createTransferChatSample(state: SampleState) {
  const transfer: OwnTransferNotice = {
    state, ownerId, pairId: "sample-pair", outgoingBankMessageId: bankId,
    incomingBankMessageId: "22222222-2222-4222-8222-222222222222", amount: "1.00", currency: "GHS",
    fromAccount: { id: "sample-hubtel", label: "Hubtel wallet" }, toAccount: { id: "sample-momo", label: "MTN MoMo" }, evidenceFingerprint: "fictional-only",
  };
  const notice = transferMention({ id: bankId, ownerId, direction: "out", amount: "1.00", currency: "GHS", kind: state === "paired" ? "transfer_own" : "payment", status: state === "paired" ? "transfer" : "needs_label", transactionId: null }, transfer);
  if (!notice) throw Error("The sample conversation could not be prepared.");
  const message: ChatMessageRecord = { id: "sample-transfer-notice", role: "assistant", channel: "web", body: notice.body, createdAt: "2026-11-04T11:09:00.000Z", clientId: "sample-transfer-notice", intent: "automation:outgoing-payment", paymentNotice: { bankMessageId: bankId, requiresPurpose: notice.requiresPurpose }, ledgerChanged: false };
  const entry: PaymentChatEntry = { state: "ready", bankMessageId: bankId, message };
  const messages = [message];
  const present = (row: ChatMessageRecord) => ({ ...row, text: row.body });
  let sequence = 0;
  const request: typeof fetch = async (input, options) => {
    const path = String(input).split("?")[0];
    if (path === "/api/chat" && (!options?.method || options.method === "GET")) return Response.json({ ok: true, ownerId, messages: messages.map(present), choices: [], paymentEntry: entry });
    if (path === "/api/chat" && options?.method === "POST") {
      let body: { text?: string; clientId?: string };
      try { body = JSON.parse(String(options.body)); } catch { return Response.json({ ok: false, text: "Try a short sample reply." }, { status: 400 }); }
      if (!body.text?.trim()) return Response.json({ ok: false, text: "Try a short sample reply." }, { status: 400 });
      sequence += 1;
      const clientId = body.clientId ?? `sample-turn-${sequence}`;
      const createdAt = new Date(Date.parse("2026-11-04T11:10:00.000Z") + sequence * 1000).toISOString();
      const incoming: ChatMessageRecord[] = [
        { id: `sample-user-${sequence}`, role: "user", channel: "web", body: body.text, clientId, createdAt },
        { id: `sample-answer-${sequence}`, role: "assistant", channel: "web", body: "This is a sample conversation only. On your account, I'd check both alerts before linking or changing anything. Nothing was saved here.", clientId, createdAt, ledgerChanged: false },
      ];
      messages.push(...incoming);
      return Response.json({ ok: true, messages: incoming.map(present), choices: [], ledgerChanged: false });
    }
    if (path === "/api/chat/empty") return Response.json({ ok: true, ownerId, financialsEmpty: false });
    return Response.json({ ok: false, text: "This sample doesn't open accounts, upload images or load your financial records." }, { status: 400 });
  };
  return { entry, messages: [toThreadMessage(message)], request };
}

export function TransferChatPreview() {
  const [state, setState] = useState<SampleState>("paired");
  const sample = useMemo(() => createTransferChatSample(state), [state]);
  return <main className="flex h-dvh min-h-0 flex-col bg-bg">
    <header className="shrink-0 border-b border-line bg-surface px-4 py-3">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
        <div><p className="text-xs text-muted">Demo · sample data only</p><h1 className="mt-1 text-base font-medium">Your transfer, in Chat</h1></div>
        <Link href="/preview/automations" className="text-sm text-accent underline underline-offset-4">Back to Automations</Link>
      </div>
      <div className="mx-auto mt-3 flex max-w-5xl flex-wrap gap-2" role="group" aria-label="Sample transfer situations">
        <button type="button" aria-pressed={state === "paired"} className={buttonClassName({ variant: state === "paired" ? "primary" : "secondary", size: "sm" })} onClick={() => setState("paired")}>Recognised transfer</button>
        <button type="button" aria-pressed={state === "candidate"} className={buttonClassName({ variant: state === "candidate" ? "primary" : "secondary", size: "sm" })} onClick={() => setState("candidate")}>Needs a quick answer</button>
      </div>
      <p className="mx-auto mt-2 max-w-5xl text-xs text-muted">Try a sample reply. This preview never changes accounts or sends notifications.</p>
    </header>
    <ChatPanel key={state} ownerId={ownerId} name="Sample" initialMessages={sample.messages} initialPaymentEntry={sample.entry} initialPaymentTarget={bankId} requestData={sample.request} financialsEmpty={false} />
  </main>;
}
