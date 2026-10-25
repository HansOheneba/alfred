"use client";

import { useState } from "react";

import { AlfredAvatar } from "@/app/components/alfred-avatar";
import { useInstallState } from "@/app/components/pwa";
import { Button, Card } from "@/app/components/ui";

function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" className="inline size-4 -translate-y-px text-[#3b8cff]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-label="Share">
      <path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </svg>
  );
}

/** Settings → App: install Alfred to the home screen. */
export function AppSection() {
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
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-gold-soft text-xs font-medium text-gold">1</span>
                <span>
                  Open this page in <span className="text-ink">Safari</span> and tap <ShareIcon /> <span className="text-ink">Share</span>.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-gold-soft text-xs font-medium text-gold">2</span>
                <span>
                  Scroll down and choose <span className="text-ink">Add to Home Screen</span>.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-gold-soft text-xs font-medium text-gold">3</span>
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
