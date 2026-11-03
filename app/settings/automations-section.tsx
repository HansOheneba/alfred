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
      <p className="mt-1 text-sm leading-6 text-muted">Payment alerts, a word from Alfred, and quiet reminders. Choose what happens automatically.</p>
    </header>
    <MacAutomationCard preview={preview} notificationsHref="#automations-notifications" />
    {preview ? <CollectorHealthPreview /> : <CollectorHealthSection key={ownerId ?? "session"} ownerId={ownerId} />}
    <p className="px-1 text-xs leading-5 text-muted">Forwarding keys and existing bank messages stay in <Link href={preview ? "#bank" : "/settings#bank"} className="font-medium text-accent underline underline-offset-4">Bank messages</Link>.</p>
    <section id="automations-notifications" className="scroll-mt-6" aria-label="Automation notification choices">
      <NotificationsSection key={ownerId ?? "session"} ownerId={ownerId} preview={preview} initial={initialNotifications} />
    </section>
  </div>;
}
