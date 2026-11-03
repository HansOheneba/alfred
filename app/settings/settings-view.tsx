"use client";

import { useEffect, useState, type ReactNode } from "react";

import { buttonClassName } from "@/app/components/button-styles";
import { Spinner } from "@/app/components/status";
import { Button, Card, Field, inputClass } from "@/app/components/ui";
import { BudgetsSection, GoalsSection } from "@/app/settings/money-sections";
import { AppSection } from "@/app/settings/app-section";
import { BankSection } from "@/app/settings/bank-section";
import { DataSection } from "@/app/settings/data-section";
import { AccountRulesSection } from "@/app/settings/account-rules-section";
import type { AccountSettings } from "@/lib/accounts/settings-store";
import type { HomeScreen } from "@/lib/web/home";
import type { Ledger } from "@/lib/web/ledger";
import { useOwnedSettingsData } from "@/app/settings/lazy-settings-data";

const SECTIONS = [
  { id: "profile", label: "Profile" },
  { id: "replies", label: "Alfred's replies" },
  { id: "budgets", label: "Budgets" },
  { id: "goals", label: "Savings goals" },
  { id: "reminders", label: "Reminders" },
  { id: "telegram", label: "Telegram" },
  { id: "bank", label: "Bank messages" },
  { id: "rules", label: "Categorisation rules" },
  { id: "app", label: "App & look" },
  { id: "data", label: "Data & privacy" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const TIMEZONES = [
  "Africa/Accra",
  "Africa/Lagos",
  "Africa/Johannesburg",
  "Africa/Nairobi",
  "Africa/Cairo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "America/Toronto",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
];

const CURRENCIES = ["GHS", "USD", "EUR", "GBP", "NGN", "KES", "ZAR", "CAD"];

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; text: string };

export function SettingsView({
  initial,
  ledger,
  botUsername,
  home,
  ownerId,
  refreshKey = "provided",
}: {
  initial: AccountSettings;
  ledger?: Ledger;
  botUsername?: string | null;
  home: HomeScreen;
  ownerId?: string;
  refreshKey?: string;
}) {
  const [section, setSection] = useState<SectionId>("profile");
  const [form, setForm] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const finance = useOwnedSettingsData<Ledger>("/api/settings/ledger", "ledger", ["budgets", "goals", "bank"].includes(section), ledger, ownerId, refreshKey);
  const telegram = useOwnedSettingsData<string | null>("/api/settings/telegram", "botUsername", section === "telegram", botUsername, ownerId, refreshKey);

  // Deep links such as /settings#budgets open the matching section.
  useEffect(() => {
    const fromHash = () => {
      const hash = window.location.hash.slice(1);
      if (SECTIONS.some((item) => item.id === hash)) setSection(hash as SectionId);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);

  // On phones the tabs scroll sideways, so keep the open one visible.
  useEffect(() => {
    document.querySelector<HTMLElement>(`[data-section="${section}"]`)?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [section]);

  function choose(id: SectionId) {
    setSection(id);
    window.history.replaceState(null, "", `#${id}`);
  }

  function update<K extends keyof AccountSettings>(key: K, value: AccountSettings[K]) {
    setSave({ kind: "idle" });
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit() {
    setSave({ kind: "saving" });
    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const payload = (await response.json()) as { ok?: boolean; text?: string; settings?: AccountSettings };
      if (!response.ok || !payload.ok) {
        setSave({ kind: "error", text: payload.text || "Those settings could not be saved." });
        return;
      }
      const next = payload.settings ?? form;
      setForm(next);
      setSaved(next);
      finance.retry();
      setSave({ kind: "saved" });
    } catch {
      setSave({ kind: "error", text: "Alfred could not reach the server." });
    }
  }

  const saveBar = <SaveBar dirty={dirty} state={save} onSave={() => void submit()} onReset={() => setForm(saved)} />;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 pb-20 sm:py-8">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-medium leading-tight tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted">How Alfred knows you, what he keeps track of, and where he can reach you.</p>
      </header>

      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        <nav
          aria-label="Settings sections"
          className="-mx-4 flex gap-1 overflow-x-auto px-4 py-2 md:sticky md:top-6 md:mx-0 md:w-52 md:shrink-0 md:flex-col md:overflow-visible md:px-0 md:py-0"
        >
          {SECTIONS.map((item) => {
            const active = item.id === section;
            return (
              <button
                key={item.id}
                type="button"
                data-section={item.id}
                onClick={() => choose(item.id)}
                aria-current={active ? "page" : undefined}
                className={`min-h-11 shrink-0 whitespace-nowrap rounded-xl px-3 py-2 text-left text-sm font-medium leading-5 transition focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent ${
                  active ? "bg-surface-2 text-ink" : "text-muted hover:bg-surface-2 hover:text-ink"
                }`}
              >
                {active ? <span className="mr-2 inline-block size-1.5 rounded-full bg-accent align-middle" aria-hidden="true" /> : null}
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="min-w-0 flex-1">
          {section === "profile" ? (
            <Card title="Profile">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Preferred name" hint="What Alfred calls you.">
                  <input
                    value={form.preferredName}
                    maxLength={80}
                    autoComplete="nickname"
                    onChange={(event) => update("preferredName", event.target.value)}
                    className={inputClass}
                  />
                </Field>
                <Field label="Currency" hint="Your main currency for totals and charts.">
                  <select value={form.currency} onChange={(event) => update("currency", event.target.value)} className={inputClass}>
                    {[...new Set([form.currency, ...CURRENCIES])].map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Timezone" hint="Decides what counts as today and when reminders arrive.">
                  <select value={form.timezone} onChange={(event) => update("timezone", event.target.value)} className={inputClass}>
                    {[...new Set([form.timezone, ...TIMEZONES])].map((zone) => (
                      <option key={zone} value={zone}>
                        {zone.replace(/_/g, " ")}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Financial goals" hint="Anything you're working towards. Alfred keeps it in mind.">
                    <textarea
                      value={form.financialGoals}
                      maxLength={2000}
                      rows={4}
                      onChange={(event) => update("financialGoals", event.target.value)}
                      className={`${inputClass} h-auto py-2 leading-6`}
                      placeholder="Save for a laptop by March, spend less on rides…"
                    />
                  </Field>
                </div>
              </div>
              {saveBar}
            </Card>
          ) : null}

          {section === "replies" ? (
            <Card title="Alfred's replies">
              <fieldset className="grid gap-3 sm:grid-cols-2">
                <legend className="sr-only">Reply length</legend>
                <Choice
                  checked={form.communicationPreference === "concise"}
                  onChange={() => update("communicationPreference", "concise")}
                  title="Concise"
                  body="Short answers: the number and a line of context."
                />
                <Choice
                  checked={form.communicationPreference === "detailed"}
                  onChange={() => update("communicationPreference", "detailed")}
                  title="A bit more detail"
                  body="Breakdowns and a little more explanation when it helps."
                />
              </fieldset>
              {saveBar}
            </Card>
          ) : null}

          {((finance.refreshing && ["budgets", "goals", "bank"].includes(section)) || (telegram.refreshing && section === "telegram")) ? <p role="status" className="flex items-center gap-2 text-sm text-muted"><Spinner />Updating…</p> : null}
          {section === "budgets" ? finance.value ? <BudgetsSection ledger={finance.value} /> : <DeferredSection title="Budgets" error={finance.error} onRetry={finance.retry} /> : null}
          {section === "goals" ? finance.value ? <GoalsSection ledger={finance.value} /> : <DeferredSection title="Savings goals" error={finance.error} onRetry={finance.retry} /> : null}

          {section === "reminders" ? (
            <Card title="Reminders">
              <p className="mb-4 text-sm text-muted">Alfred sends these on Telegram, in your timezone ({form.timezone.replace(/_/g, " ")}).</p>
              <div className="flex flex-col divide-y divide-line">
                <Reminder
                  label="Morning check-in"
                  description="A nudge to plan the day's spending."
                  enabled={form.morningEnabled}
                  time={form.morningTime}
                  onEnabled={(value) => update("morningEnabled", value)}
                  onTime={(value) => update("morningTime", value)}
                />
                <Reminder
                  label="Commute"
                  description="A reminder to log transport."
                  enabled={form.commuteEnabled}
                  time={form.commuteTime}
                  onEnabled={(value) => update("commuteEnabled", value)}
                  onTime={(value) => update("commuteTime", value)}
                />
                <Reminder
                  label="Evening review"
                  description="Catch anything you didn't log today."
                  enabled={form.eveningEnabled}
                  time={form.eveningTime}
                  onEnabled={(value) => update("eveningEnabled", value)}
                  onTime={(value) => update("eveningTime", value)}
                />
              </div>
              {saveBar}
            </Card>
          ) : null}

          {section === "telegram" ? (
            telegram.value !== undefined ? <TelegramSection form={form} saved={saved} botUsername={telegram.value} update={update} saveBar={saveBar} /> : <DeferredSection title="Telegram" error={telegram.error} onRetry={telegram.retry} />
          ) : null}

          {section === "bank" ? finance.value ? <BankSection bank={finance.value.bank} currency={finance.value.currency} /> : <DeferredSection title="Bank messages" error={finance.error} onRetry={finance.retry} /> : null}
          {section === "rules" ? <AccountRulesSection /> : null}
          {section === "app" ? <AppSection home={home} /> : null}
          {section === "data" ? <DataSection /> : null}
        </div>
      </div>
    </div>
  );
}

function DeferredSection({ title, error, onRetry }: { title: string; error?: string; onRetry: () => void }) {
  return <Card title={title}>
    <p role={error ? "alert" : "status"} className={`flex items-center gap-2 text-sm ${error ? "text-danger" : "text-muted"}`}>
      {error ? null : <Spinner />}{error || "Loading this section…"}
    </p>
    {error ? <Button className="mt-4" onClick={onRetry}>Try again</Button> : null}
  </Card>;
}

function SaveBar({ dirty, state, onSave, onReset }: { dirty: boolean; state: SaveState; onSave: () => void; onReset: () => void }) {
  return (
    <div className="mt-6 flex flex-wrap items-center justify-end gap-3 border-t border-line pt-4">
      <p className="mr-auto text-sm" role="status" aria-live="polite">
        {state.kind === "error" ? (
          <span className="text-danger">{state.text}</span>
        ) : state.kind === "saved" && !dirty ? (
          <span className="text-success">Saved ✓</span>
        ) : dirty ? (
          <span className="text-muted">Unsaved changes</span>
        ) : null}
      </p>
      {dirty ? (
        <Button variant="ghost" onClick={onReset} disabled={state.kind === "saving"}>
          Discard
        </Button>
      ) : null}
      <Button variant="primary" onClick={onSave} disabled={!dirty || state.kind === "saving"} aria-busy={state.kind === "saving"} aria-label="Save changes">
        {state.kind === "saving" ? <Spinner /> : "Save changes"}
      </Button>
    </div>
  );
}

function Choice({ checked, onChange, title, body }: { checked: boolean; onChange: () => void; title: string; body: string }) {
  return (
    <label
      className={`flex cursor-pointer gap-3 rounded-xl border p-4 transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-4 has-[:focus-visible]:outline-accent ${
        checked ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong"
      }`}
    >
      <input type="radio" name="reply-length" checked={checked} onChange={onChange} className="mt-1 accent-[var(--accent)]" />
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-1 block text-sm text-muted">{body}</span>
      </span>
    </label>
  );
}

function Reminder({
  label,
  description,
  enabled,
  time,
  onEnabled,
  onTime,
}: {
  label: string;
  description: string;
  enabled: boolean;
  time: string;
  onEnabled: (value: boolean) => void;
  onTime: (value: string) => void;
}) {
  const id = label.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="flex items-start gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby={`${id}-label`}
          onClick={() => onEnabled(!enabled)}
          className="grid size-11 shrink-0 place-items-center rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
        >
          <span aria-hidden="true" className={`relative h-6 w-11 rounded-full transition ${enabled ? "bg-accent" : "bg-surface-2 ring-1 ring-line-strong"}`}>
            <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${enabled ? "left-[22px]" : "left-0.5"}`} />
          </span>
        </button>
        <div>
          <p id={`${id}-label`} className="text-sm font-medium">
            {label}
          </p>
          <p className="text-xs text-muted">{description}</p>
        </div>
      </div>
      <label className="sr-only" htmlFor={`${id}-time`}>
        {label} time
      </label>
      <input
        id={`${id}-time`}
        type="time"
        value={time}
        disabled={!enabled}
        onChange={(event) => onTime(event.target.value)}
        className={`${inputClass} w-32 disabled:opacity-50`}
      />
    </div>
  );
}

function TelegramSection({
  form,
  saved,
  botUsername,
  update,
  saveBar,
}: {
  form: AccountSettings;
  saved: AccountSettings;
  botUsername: string | null;
  update: <K extends keyof AccountSettings>(key: K, value: AccountSettings[K]) => void;
  saveBar: ReactNode;
}) {
  const status = saved.telegramLocked ? "linked" : saved.telegramUserId ? "waiting" : "none";
  const badge = {
    linked: { text: "Connected", className: "bg-success/15 text-success" },
    waiting: { text: "Waiting for your first message", className: "bg-accent-soft text-accent" },
    none: { text: "Not connected", className: "bg-surface-2 text-muted" },
  }[status];
  const botLink = botUsername ? `https://t.me/${botUsername}` : null;

  return (
    <Card title="Telegram">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-bg p-4">
        <div>
          <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${badge.className}`}>{badge.text}</span>
          <p className="mt-2 text-sm text-muted">
            {status === "linked"
              ? `Alfred is chatting with Telegram ID ${saved.telegramUserId}. Your chat history and records are shared with the website.`
              : status === "waiting"
                ? `ID ${saved.telegramUserId} is saved. Send Alfred any message on Telegram to finish connecting.`
                : "Connect Telegram to log spending on the go and get reminders."}
          </p>
          {botUsername ? <p className="mt-1 text-xs text-faint">@{botUsername}</p> : null}
        </div>
        {botLink ? (
          <a
            href={botLink}
            target="_blank"
            rel="noreferrer"
            className={buttonClassName({ variant: "primary" })}
          >
            Open Alfred on Telegram
          </a>
        ) : null}
      </div>

      {status !== "linked" ? (
        <ol className="mt-5 flex flex-col gap-3 text-sm">
          {[
            botLink ? "Open Alfred on Telegram with the button above." : "Open Alfred's bot on Telegram.",
            "Send /id. Alfred replies with your Telegram user ID.",
            "Paste that number below and save.",
            "Send Alfred any message. That connects and locks the ID to your account.",
          ].map((step, index) => (
            <li key={step} className="flex gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-medium text-accent">{index + 1}</span>
              <span className="pt-0.5 text-muted">{step}</span>
            </li>
          ))}
        </ol>
      ) : null}

      <div className="mt-5 max-w-sm">
        <Field
          label="Telegram user ID"
          hint={
            form.telegramLocked
              ? "Locked because Alfred already received a message from this account."
              : "You can change this until the first message arrives from that Telegram account."
          }
        >
          <input
            inputMode="numeric"
            pattern="[0-9]*"
            value={form.telegramUserId}
            disabled={form.telegramLocked}
            onChange={(event) => update("telegramUserId", event.target.value.replace(/\D/g, ""))}
            className={`${inputClass} disabled:opacity-60`}
            placeholder="e.g. 123456789"
          />
        </Field>
      </div>
      {form.telegramLocked ? null : saveBar}
    </Card>
  );
}
