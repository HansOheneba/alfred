"use client";

import Link from "next/link";
import { MacAutomationCard } from "@/app/settings/bank-section";
import { NotificationsSection, type NotificationSettingsData } from "@/app/settings/notifications-section";
import { CollectorHealthPreview, CollectorHealthSection } from "@/app/settings/collector-health-section";

export function AutomationsSection({ ownerId, preview = false, initialNotifications }: {
  ownerId?: string;
  preview?: boolean;
  initialNotifications?: NotificationSettingsData;
}) {
  return <div className="flex flex-col gap-5">
    <header>
      <h2 className="font-display text-lg font-medium tracking-tight">Automations</h2>
      <p className="mt-1 text-sm leading-6 text-muted">How Alfred keeps you up to date.</p>
    </header>
    <MacAutomationCard preview={preview} notificationsHref="#automations-notifications" />
    <details className="rounded-xl border border-line bg-surface px-5 py-1 sm:px-6">
      <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium text-muted">Mac status and saved alerts</summary>
      <div className="pb-4">{preview ? <CollectorHealthPreview /> : <CollectorHealthSection key={ownerId ?? "session"} ownerId={ownerId} />}<p className="mt-3 text-xs text-muted"><Link href={preview ? "#bank" : "/settings#bank"} className="font-medium text-accent underline underline-offset-4">Bank messages and connection settings</Link></p></div>
    </details>
    <section id="automations-notifications" className="scroll-mt-6" aria-label="Automation notification choices">
      <NotificationsSection key={ownerId ?? "session"} ownerId={ownerId} preview={preview} initial={initialNotifications} />
    </section>
  </div>;
}
