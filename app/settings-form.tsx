"use client";

import { useState, type FormEvent, type ReactNode } from "react";

import type { AccountSettings } from "@/lib/accounts/settings-store";

export function SettingsForm({ initial }: { initial: AccountSettings }) {
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  function update<K extends keyof AccountSettings>(key: K, value: AccountSettings[K]) {
    setSaved(false);
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const payload = (await response.json()) as { ok?: boolean; text?: string; settings?: AccountSettings };
      if (!response.ok || !payload.ok) {
        setError(payload.text || "Those settings could not be saved.");
        return;
      }
      if (payload.settings) setForm(payload.settings);
      setSaved(true);
    } catch {
      setError("Alfred could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-6" onSubmit={onSubmit}>
      <fieldset className="flex flex-col gap-4">
        <legend className="text-sm font-medium">Profile</legend>
        <Field label="Preferred name">
          <input
            value={form.preferredName}
            maxLength={80}
            onChange={(event) => update("preferredName", event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Currency">
          <input
            value={form.currency}
            maxLength={3}
            onChange={(event) => update("currency", event.target.value.toUpperCase())}
            className={inputClass}
          />
        </Field>
        <Field label="Timezone">
          <input
            value={form.timezone}
            onChange={(event) => update("timezone", event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Replies">
          <select
            value={form.communicationPreference}
            onChange={(event) => update("communicationPreference", event.target.value as AccountSettings["communicationPreference"])}
            className={inputClass}
          >
            <option value="concise">Concise</option>
            <option value="detailed">A bit more detail</option>
          </select>
        </Field>
        <Field label="Financial goals">
          <textarea
            value={form.financialGoals}
            maxLength={2000}
            rows={3}
            onChange={(event) => update("financialGoals", event.target.value)}
            className={inputClass}
          />
        </Field>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium">Telegram</legend>
        <Field label="Telegram user ID">
          <input
            inputMode="numeric"
            value={form.telegramUserId}
            disabled={form.telegramLocked}
            onChange={(event) => update("telegramUserId", event.target.value)}
            className={inputClass}
          />
        </Field>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {form.telegramLocked
            ? "This ID is locked because Alfred already received a message from it."
            : "You can change this until the first message arrives from that Telegram account. Send /id to the bot to see the number."}
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="text-sm font-medium">Reminders</legend>
        <Reminder
          label="Morning check-in"
          enabled={form.morningEnabled}
          time={form.morningTime}
          onEnabled={(value) => update("morningEnabled", value)}
          onTime={(value) => update("morningTime", value)}
        />
        <Reminder
          label="Commute"
          enabled={form.commuteEnabled}
          time={form.commuteTime}
          onEnabled={(value) => update("commuteEnabled", value)}
          onTime={(value) => update("commuteTime", value)}
        />
        <Reminder
          label="Evening review"
          enabled={form.eveningEnabled}
          time={form.eveningTime}
          onEnabled={(value) => update("eveningEnabled", value)}
          onTime={(value) => update("eveningTime", value)}
        />
      </fieldset>

      {error ? (
        <p className="text-sm text-red-700 dark:text-red-400" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? <p className="text-sm text-neutral-600 dark:text-neutral-400">Saved.</p> : null}
      <button
        type="submit"
        disabled={busy}
        className="rounded-full bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
      >
        {busy ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      {children}
    </label>
  );
}

function Reminder({
  label,
  enabled,
  time,
  onEnabled,
  onTime,
}: {
  label: string;
  enabled: boolean;
  time: string;
  onEnabled: (value: boolean) => void;
  onTime: (value: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={enabled} onChange={(event) => onEnabled(event.target.checked)} />
        {label}
      </label>
      <input type="time" value={time} onChange={(event) => onTime(event.target.value)} className={inputClass} />
    </div>
  );
}

const inputClass = "rounded-xl border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-700";
