"use client";

import { useReducer, useState } from "react";
import Link from "next/link";

import { AlfredAvatar } from "@/app/components/alfred-avatar";
import { Button, Card } from "@/app/components/ui";
import { MacAutomationCard } from "@/app/settings/bank-section";
import { DiscreetNotificationPreview, EMPTY_NOTIFICATION_PREFERENCES, NotificationsSection, type NotificationSettingsData } from "@/app/settings/notifications-section";

const previewSettings: NotificationSettingsData = {
  ownerId: "00000000-0000-4000-8000-000000000001",
  preferences: { ...EMPTY_NOTIFICATION_PREFERENCES, paymentMentions: true, paymentMentionsSince: "2026-11-03T10:00:00.000Z" },
  push: { configured: false, publicKey: null, deliveryEnabled: false, schedulesEnabled: false },
  devices: [],
};

export type SampleReplyState = { userReply: string; category: "Business" | "Gift" | null; description: "freelance work" | "birthday money from grandma" | null; deferred: boolean };
export const EMPTY_SAMPLE_REPLY: SampleReplyState = { userReply: "", category: null, description: null, deferred: false };
export function sampleReplyReducer(state: SampleReplyState, action: { type: "reply"; text: string } | { type: "defer" } | { type: "reset" }): SampleReplyState {
  if (action.type === "reset") return { ...EMPTY_SAMPLE_REPLY };
  if (action.type === "reply") {
    const userReply = action.text.trim().slice(0, 160);
    if (!userReply) return state;
    const normalized = userReply.toLowerCase().replace(/[.!?]+$/, "").trim();
    const explicitFreelance = ["it was for freelance work", "freelance work", "it was for freelance", "freelance"].includes(normalized);
    const explicitBirthday = ["birthday money from grandma", "it was birthday money from grandma", "birthday gift from grandma"].includes(normalized);
    return { userReply, category: explicitFreelance ? "Business" : explicitBirthday ? "Gift" : null, description: explicitFreelance ? "freelance work" : explicitBirthday ? "birthday money from grandma" : null, deferred: false };
  }
  return { ...state, category: null, description: null, deferred: true };
}

export function SmsAutomationPreview({ knownCopy, unknownCopy, uncertainCopy }: { knownCopy: string; unknownCopy: string; uncertainCopy: string }) {
  const [example, setExample] = useState<"known" | "unknown" | "uncertain">("known");
  const [reviewed, setReviewed] = useState(false);
  const [reply, setReply] = useState("");
  const [conversation, dispatch] = useReducer(sampleReplyReducer, EMPTY_SAMPLE_REPLY);
  const copy = example === "known" ? knownCopy : example === "unknown" ? unknownCopy : uncertainCopy;
  return (
    <main className="min-h-screen bg-bg">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <div className="flex items-center gap-3"><AlfredAvatar sizeClass="size-9" sizes="36px" loading="eager" /><div><p className="font-display text-lg font-medium tracking-tight">Alfred</p><p className="text-xs text-muted">Payment alerts, with a personal follow-up</p></div></div>
          <span className="rounded-full border border-line bg-bg px-3 py-1.5 text-xs font-medium text-muted">Local preview · no live delivery</span>
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-12">
        <div className="mb-8 max-w-2xl">
          <p className="text-xs font-medium uppercase tracking-[0.15em] text-accent">SMS automation</p>
          <h1 className="mt-3 font-display text-3xl font-medium leading-tight tracking-tight sm:text-4xl">When a payment alert arrives,<br className="hidden sm:block" /> Alfred speaks up.</h1>
          <p className="mt-4 text-sm leading-7 text-muted sm:text-base">A useful message in your private chat. A discreet nudge on your phone, including overnight. Payment details stay inside Alfred, and uncertain alerts stay clearly marked.</p>
          <Link href="/preview/automations#automations" className="mt-4 inline-flex min-h-11 items-center text-sm font-medium text-accent underline underline-offset-4">See Automations in Settings →</Link>
        </div>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.65fr)_minmax(17rem,1fr)]">
          <Card title={<span className="flex items-center gap-2"><span className="size-1.5 rounded-full bg-accent" aria-hidden="true" />Inside your private chat</span>} action={<span className="text-xs text-faint">Fictional example</span>} className="overflow-hidden">
            <div className="mb-5 grid w-full grid-cols-3 gap-1 rounded-xl border border-line bg-bg p-1" role="group" aria-label="Example alert type">
              {([{ label: "Known purpose", value: "known" }, { label: "Unknown purpose", value: "unknown" }, { label: "Uncertain alert", value: "uncertain" }] as const).map((option) => <button key={option.label} type="button" aria-pressed={example === option.value} onClick={() => { setExample(option.value); setReviewed(false); setReply(""); dispatch({ type: "reset" }); }} className={`min-h-11 min-w-0 rounded-lg px-2 py-2 text-[11px] font-medium leading-4 transition focus-visible:outline-2 focus-visible:outline-accent sm:text-xs ${example === option.value ? "bg-surface-2 text-ink" : "text-muted hover:text-ink"}`}>{option.label}</button>)}
            </div>
            <div className="rounded-2xl border border-line bg-bg px-4 py-5 sm:px-6">
              <p className="mb-5 text-center text-[11px] text-faint">Sample activity · 10:42am</p>
              <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-surface-2 px-4 py-3 text-sm leading-6">Let me know when a payment comes in.</div>
              <div className="mt-6 flex items-start gap-3">
                <AlfredAvatar sizeClass="mt-1 size-8" sizes="32px" />
                <div className="min-w-0 flex-1">
                  <p className="mb-2 text-xs font-medium text-muted">Alfred</p>
                  <div className="rounded-2xl rounded-tl-md border border-line bg-surface px-4 py-4">
                    <span className={`mb-3 inline-flex rounded-full px-2 py-1 text-[11px] font-medium ${example === "known" ? "bg-accent-soft text-accent" : "bg-surface-2 text-muted"}`}>{example === "known" ? "Purpose already known" : example === "unknown" ? "Purpose needed" : "Possible incoming alert"}</span>
                    <p className="text-sm leading-7 text-ink">{copy.split(/(GH₵[\d,.]+)/).map((part, index) => index % 2 ? <span key={index} className="amount font-medium">{part}</span> : part)}</p>
                    <div className="mt-4 flex flex-wrap items-center gap-3"><Button size="sm" onClick={() => setReviewed(true)}>{example === "known" ? "View sample record" : "Review sample alert"}</Button><span className="text-[11px] text-faint">Shown once for this alert</span></div>
                    {reviewed ? <p className="mt-3 text-xs leading-5 text-muted" role="status">Sample opened. No financial records were created or changed.</p> : null}
                  </div>
                </div>
              </div>
              {example === "unknown" ? <>
                {conversation.userReply ? <div className="mt-5" aria-live="polite">
                  <div className="ml-auto max-w-[85%] break-words rounded-2xl rounded-br-md bg-surface-2 px-4 py-3 text-sm leading-6">{conversation.userReply}</div>
                  <div className="mt-4 flex items-start gap-3"><AlfredAvatar sizeClass="mt-1 size-8" sizes="32px" /><div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border border-line bg-surface px-4 py-4">
                    {conversation.category ? <p className="text-sm leading-7">Filed <span className="amount">GH₵80.00</span> under {conversation.category}.</p> : conversation.deferred ? <p className="text-sm leading-7">Okay, I’ll leave this sample in Review.</p> : <>
                      <p className="text-sm leading-7">What was the payment for? I’ll leave it in Review until that’s clear. For this sample, try “It was for freelance work” or “Birthday money from grandma”.</p>
                      <Button size="sm" className="mt-3" onClick={() => dispatch({ type: "defer" })}>Keep in Review</Button>
                    </>}
                    <p className="mt-3 text-xs leading-5 text-muted">Fictional conversation only. No real records are changed.</p>
                  </div></div>
                </div> : null}
                <form className="mt-6 border-t border-line pt-4" onSubmit={(event) => { event.preventDefault(); if (reply.trim()) { dispatch({ type: "reply", text: reply }); setReply(""); } }}>
                  <label htmlFor="sample-payment-reply" className="text-xs font-medium text-muted">Reply to this sample</label>
                  <div className="mt-2 flex gap-2"><input id="sample-payment-reply" value={reply} onChange={(event) => setReply(event.target.value)} maxLength={160} autoComplete="off" placeholder="It was for freelance work" className="min-w-0 flex-1 rounded-xl border border-line-strong bg-surface px-3 py-3 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft" /><button type="submit" disabled={!reply.trim()} className="min-h-11 shrink-0 rounded-xl bg-accent px-4 text-sm font-medium text-[var(--accent-ink)] disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">Reply</button></div>
                  <div className="mt-2 flex flex-wrap gap-x-4"><button type="button" onClick={() => setReply("It was for freelance work")} className="min-h-9 text-left text-xs font-medium text-accent underline underline-offset-4">Use sample reply</button><button type="button" onClick={() => setReply("Birthday money from grandma")} className="min-h-9 text-left text-xs font-medium text-accent underline underline-offset-4">Use birthday example</button></div>
                  <p className="mt-1 text-[11px] leading-5 text-faint">A clear reply labels this fictional sample. Vague replies stay in Review. Nothing is sent or saved.</p>
                </form>
              </> : null}
            </div>
            <p className="mt-4 text-xs leading-5 text-muted">These are fictional examples, not a bank confirmation. Real notices describe the alert Alfred detected and how it was handled.</p>
          </Card>
          <div className="flex flex-col gap-5">
            <Card title="On your lock screen">
              <DiscreetNotificationPreview />
              <p className="mt-4 text-xs leading-6 text-muted">No payment amounts, names, balances or SMS text. Opening the notification takes you to Alfred, where you sign in to see the details.</p>
            </Card>
            <Card title="You stay in control">
              <ul className="space-y-3 text-sm leading-6 text-muted"><li className="flex gap-2"><span className="text-accent" aria-hidden="true">✓</span>Only new alerts from selected providers</li><li className="flex gap-2"><span className="text-accent" aria-hidden="true">✓</span>Credential codes and personal senders excluded</li><li className="flex gap-2"><span className="text-accent" aria-hidden="true">✓</span>Separate chat and device choices</li><li className="flex gap-2"><span className="text-accent" aria-hidden="true">✓</span>Retry protection prevents repeat mentions</li></ul>
            </Card>
          </div>
        </div>

        <div className="mt-8 grid items-start gap-5 lg:grid-cols-2">
          <MacAutomationCard preview />
          <section id="notification-choices" aria-label="Notification choices preview" className="scroll-mt-6">
            <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-medium">Your notification choices</h2><span className="text-xs text-faint">Preview controls only</span></div>
            <NotificationsSection preview initial={previewSettings} />
          </section>
        </div>
        <p className="mt-8 border-t border-line pt-5 text-xs leading-6 text-faint">This local preview uses fictional records. It does not read Messages, create credentials, request browser permission, register a device, change your settings or send notifications. Mac capture and live delivery remain off pending the required setup checks.</p>
      </div>
    </main>
  );
}
