"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Card } from "@/app/components/ui";
import { AutomationsSection } from "@/app/settings/automations-section";
import { EMPTY_NOTIFICATION_PREFERENCES, type NotificationSettingsData } from "@/app/settings/notifications-section";
import { resolveSettingsSection, SETTINGS_SECTIONS, SettingsNavigation, type SettingsSectionId } from "@/app/settings/settings-navigation";

const sample: NotificationSettingsData = {
  ownerId: "00000000-0000-4000-8000-000000000001",
  preferences: { ...EMPTY_NOTIFICATION_PREFERENCES },
  push: { configured: false, publicKey: null, deliveryEnabled: false, schedulesEnabled: false },
  devices: [],
};

/** Shared Settings layout and controls with fictional state and no account reads. */
export function AutomationsSettingsPreview() {
  const [section, setSection] = useState<SettingsSectionId>("automations");
  useEffect(() => {
    const fromHash = () => { const next = resolveSettingsSection(window.location.hash); if (next) setSection(next); };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);
  useEffect(() => {
    document.querySelector<HTMLElement>(`[data-section="${section}"]`)?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [section]);
  function choose(next: SettingsSectionId) {
    setSection(next);
    window.history.replaceState(null, "", `#${next}`);
  }
  const label = SETTINGS_SECTIONS.find((item) => item.id === section)!.label;
  return <main className="min-h-screen bg-bg">
    <div className="border-b border-line bg-surface px-4 py-3 text-center text-xs leading-5 text-muted">Local preview · fictional choices only · no account changes</div>
    <div className="mx-auto w-full max-w-5xl px-4 py-6 pb-20 sm:py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="font-display text-2xl font-medium leading-tight tracking-tight">Settings</h1><p className="mt-1 text-sm text-muted">How Alfred knows you, what he keeps track of, and where he can reach you.</p></div>
        <div className="flex flex-wrap gap-x-4"><Link href="/preview/automations/mac-setup" className="inline-flex min-h-11 items-center text-xs font-medium text-accent underline underline-offset-4">Try fictional Mac setup</Link><Link href="/preview/sms-automation" className="inline-flex min-h-11 items-center text-xs font-medium text-accent underline underline-offset-4">View payment conversation examples</Link></div>
      </header>
      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        <SettingsNavigation section={section} onChoose={choose} />
        <div className="min-w-0 flex-1">
          <div hidden={section !== "automations"}><AutomationsSection preview initialNotifications={sample} /></div>
          {section !== "automations" ? <Card title={label}><p className="text-sm leading-6 text-muted">Your existing {label.toLowerCase()} settings stay here. This preview is focused on the new Automations section.</p><button type="button" onClick={() => choose("automations")} className="mt-4 min-h-11 text-sm font-medium text-accent underline underline-offset-4">Back to Automations</button></Card> : null}
        </div>
      </div>
      <p className="mt-8 text-xs leading-5 text-faint">This preview does not read Messages, create a forwarding key, request notification permission, register a device, activate capture or send a notification.</p>
    </div>
  </main>;
}
