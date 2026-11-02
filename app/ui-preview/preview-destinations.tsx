"use client";

import Link from "next/link";
import { buttonClassName } from "@/app/components/button-styles";
import { useState, type MouseEvent, type ReactNode } from "react";

import { Card } from "@/app/components/ui";
import { InvestmentsClient } from "@/app/investments/investments-client";
import { AccountsPreview } from "./accounts-preview";
import { previewInvestments } from "@/ui-preview/destination-fixtures";

import { PreviewFrame } from "./preview-screen";
import { ChatPreview } from "./chat-preview";

export type PreviewDestinationSection = "chat" | "accounts" | "investments" | "review" | "settings";

function ReadOnlyScreen({ children, section }: { children: ReactNode; section: PreviewDestinationSection }) {
  const [notice, setNotice] = useState("");
  function keepReadOnly(event: MouseEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("button")) {
      event.preventDefault();
      event.stopPropagation();
      setNotice("Read-only screen preview. No records or settings were changed.");
    }
  }
  return (
    <div className={`alfred-preview-destination alfred-preview-${section}`} onClickCapture={keepReadOnly} onSubmitCapture={(event) => { event.preventDefault(); event.stopPropagation(); setNotice("Read-only screen preview. No records or settings were changed."); }}>
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-2 px-4 pt-5 text-xs text-muted sm:px-8">
        <p>Synthetic data · Existing Investments screen · Read-only</p>
        <Link href="/ui-preview" className={buttonClassName({ variant: "ghost", size: "sm" })}>Back to Overview</Link>
      </div>
      {notice ? <p role="status" className="mx-auto mt-3 w-[calc(100%-2rem)] max-w-5xl rounded-xl border border-line bg-accent-soft px-4 py-3 text-sm text-accent">{notice}</p> : null}
      {children}
      <style>{`.alfred-preview-review .fixed { position: static; margin-top: 1rem; } .alfred-preview-review > div:last-of-type { padding-bottom: 2rem; }`}</style>
    </div>
  );
}

const SETTINGS = [
  ["Profile", "Alex · GHS · Africa/Accra"],
  ["Alfred's replies", "Response preferences"],
  ["Budgets", "Food, Transport and Personal"],
  ["Savings goals", "Emergency fund and December trip"],
  ["Reminders", "Scheduled reminders"],
  ["Telegram", "Telegram connection"],
  ["Bank messages", "GCB card and MoMo snapshots"],
  ["App & look", "Use the appearance control in the top bar"],
  ["Data & privacy", "Use Hide amounts to mask figures"],
] as const;

function SettingsPreview() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-7 sm:px-8">
      <div><h1 className="text-2xl font-semibold tracking-tight">Settings</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted">Read-only preview of the existing settings categories. Account connections and saved preferences are not connected here.</p></div>
      <Card title="Your settings">
        <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">{SETTINGS.map(([label, value]) => <div key={label}><dt className="text-sm font-medium text-ink">{label}</dt><dd className="mt-1 text-xs leading-5 text-muted">{value}</dd></div>)}</dl>
      </Card>
      <p className="text-xs leading-5 text-muted">Synthetic data only. The app&apos;s existing Settings screen and authentication are unchanged.</p>
      <Link href="/ui-preview" className={buttonClassName({ variant: "ghost", size: "sm", className: "self-start" })}>Back to Overview</Link>
    </div>
  );
}

export function PreviewDestination({ section }: { section: PreviewDestinationSection }) {
  return (
    <PreviewFrame section={section}>
      {section === "chat" ? <ChatPreview /> : section === "settings" ? <SettingsPreview /> : section === "accounts" || section === "review" ? <AccountsPreview /> : (
        <ReadOnlyScreen section={section}>
          <InvestmentsClient initial={previewInvestments} />
        </ReadOnlyScreen>
      )}
    </PreviewFrame>
  );
}
