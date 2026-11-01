"use client";

import { useState, useTransition, type ReactNode } from "react";

import { AlfredAvatar } from "@/app/components/alfred-avatar";
import { useAppearance } from "@/app/components/app-shell";
import { useInstallState } from "@/app/components/pwa";
import { Button, Card } from "@/app/components/ui";
import { setHomeScreen } from "@/app/settings/actions";
import type { HomeScreen } from "@/lib/web/home";

function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" className="inline size-4 -translate-y-px text-[#3b8cff]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-label="Share">
      <path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </svg>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; hint: ReactNode }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid gap-2 sm:grid-cols-2">
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            onClick={() => onChange(option.value)}
            className={`rounded-xl border p-3 text-left transition focus-visible:outline-2 focus-visible:outline-accent ${
              checked ? "border-accent bg-accent-soft" : "border-line hover:bg-surface-2"
            }`}
          >
            <span className={`block text-sm font-medium ${checked ? "text-accent" : "text-ink"}`}>{option.label}</span>
            <span className="mt-0.5 block text-xs leading-5 text-muted">{option.hint}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Settings → App & look: appearance, which screen opens first, installing, signing out. */
export function AppSection({ home: initialHome }: { home: HomeScreen }) {
  const [appearance, setAppearance] = useAppearance();
  const [home, setHome] = useState(initialHome);
  const [saving, startSaving] = useTransition();

  return (
    <div className="flex flex-col gap-4">
      <Card title="Appearance">
        <Segmented
          label="Appearance"
          value={appearance}
          onChange={setAppearance}
          options={[
            { value: "light", label: "Light", hint: "The default. Bright and calm." },
            { value: "dark", label: "Dark", hint: "Easier on the eyes at night. Saved on this device." },
          ]}
        />
      </Card>
      <Card title="Start on" action={saving ? <span className="text-xs text-muted">Saving…</span> : null}>
        <Segmented
          label="Start on"
          value={home}
          onChange={(next) => {
            setHome(next);
            startSaving(async () => {
              setHome(await setHomeScreen(next));
            });
          }}
          options={[
            { value: "chat", label: "Chat", hint: "Open straight into a conversation with Alfred." },
            { value: "overview", label: "Overview", hint: "Open on your balances and this month's numbers." },
          ]}
        />
      </Card>
      <InstallCard />
      <Card title="Account">
        <form action="/api/sign-out" method="post" className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted">Sign out of Alfred on this device.</p>
          <Button type="submit">Sign out</Button>
        </form>
      </Card>
    </div>
  );
}

function InstallCard() {
  const state = useInstallState();
  const [declined, setDeclined] = useState(false);

  return (
    <Card title="Install Alfred">
      <div className="flex items-start gap-4">
        <AlfredAvatar sizeClass="size-14" alt="" sizes="56px" />
        <div className="min-w-0 flex-1 text-sm leading-6">
          <p className="text-ink">Put Alfred on your home screen. He opens full screen like an app, loads faster, and stays signed in.</p>

          {state.kind === "installed" ? (
            <p className="mt-3 inline-flex items-center gap-2 rounded-full bg-success/10 px-3 py-1 text-xs font-medium text-success">
              <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
              Installed. You&apos;re using the app.
            </p>
          ) : null}

          {state.kind === "prompt" ? (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                onClick={async () => {
                  const accepted = await state.install();
                  setDeclined(!accepted);
                }}
              >
                Install Alfred
              </Button>
              {declined ? <span className="text-xs text-muted">No problem. You can install him any time from here.</span> : null}
            </div>
          ) : null}

          {state.kind === "ios" ? (
            <ol className="mt-4 flex flex-col gap-2.5 text-muted">
              <li className="flex gap-3">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-medium text-accent">1</span>
                <span>
                  Open this page in <span className="text-ink">Safari</span> and tap <ShareIcon /> <span className="text-ink">Share</span>.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-medium text-accent">2</span>
                <span>
                  Scroll down and choose <span className="text-ink">Add to Home Screen</span>.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-medium text-accent">3</span>
                <span>
                  Tap <span className="text-ink">Add</span>, then open Alfred from your home screen and sign in once.
                </span>
              </li>
            </ol>
          ) : null}

          {state.kind === "unsupported" ? (
            <p className="mt-3 text-muted">
              This browser can&apos;t install apps from a button. Open Alfred in Chrome or Edge on Android or desktop, or in Safari on iPhone, and come back here.
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
