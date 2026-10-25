"use client";

import { useEffect, useSyncExternalStore } from "react";

/** Chrome's install event, which isn't in the DOM typings yet. */
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

// The browser fires `beforeinstallprompt` once, often before Settings is open,
// so it's kept here for the install card to use later.
let deferredPrompt: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as InstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    notify();
  });
}

/** Registers the service worker once, in production builds only. */
export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
      // Without a service worker Alfred still works; it just loses offline support.
    });
  }, []);
  return null;
}

export type InstallState =
  | { kind: "installed" }
  | { kind: "prompt"; install: () => Promise<boolean> }
  | { kind: "ios" }
  | { kind: "unsupported" };

function subscribe(listener: () => void) {
  listeners.add(listener);
  const media = window.matchMedia("(display-mode: standalone)");
  media.addEventListener("change", listener);
  return () => {
    listeners.delete(listener);
    media.removeEventListener("change", listener);
  };
}

function snapshot(): string {
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (standalone) return "installed";
  if (deferredPrompt) return "prompt";
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return ios ? "ios" : "unsupported";
}

export function useInstallState(): InstallState {
  const kind = useSyncExternalStore(subscribe, snapshot, () => "unsupported");
  if (kind === "installed") return { kind: "installed" };
  if (kind === "ios") return { kind: "ios" };
  if (kind === "prompt") {
    return {
      kind: "prompt",
      install: async () => {
        const event = deferredPrompt;
        if (!event) return false;
        await event.prompt();
        const choice = await event.userChoice;
        deferredPrompt = null;
        notify();
        return choice.outcome === "accepted";
      },
    };
  }
  return { kind: "unsupported" };
}
