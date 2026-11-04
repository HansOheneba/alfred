"use client";

import Link from "next/link";
import { useSyncExternalStore, type ReactNode } from "react";

import { useChatViewport } from "./chat-viewport";
import { buttonClassName } from "./button-styles";
import { AlfredAvatar } from "@/app/components/alfred-avatar";
import { serializeBrowserPreferenceWrite } from "@/lib/portability/browser-preferences-lock";
import "./app-ui.css";

export type Section = "chat" | "dashboard" | "accounts" | "investments" | "review" | "settings";

const NAV: { section: Section; href: string; label: string; icon: ReactNode }[] = [
  {
    section: "chat",
    href: "/chat",
    label: "Chat",
    icon: <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z" />,
  },
  {
    section: "dashboard",
    href: "/dashboard",
    label: "Overview",
    icon: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
  },
  {
    section: "accounts", href: "/accounts", label: "Accounts",
    icon: <path d="M3 7h16a2 2 0 0 1 2 2v10H5a2 2 0 0 1-2-2V7Zm0 0V5a2 2 0 0 1 2-2h12v4m0 5h4m-4 0v3h4" />,
  },
  {
    section: "investments",
    href: "/investments",
    label: "Investments",
    icon: <path d="m3 18 6-6 4 4 8-11m-6 0h6v6" />,
  },
  {
    section: "settings",
    href: "/settings",
    label: "Settings",
    icon: (
      <>
        <path d="M3 6h18M3 12h18M3 18h18" />
        <circle cx="8" cy="6" r="2" fill="currentColor" />
        <circle cx="16" cy="12" r="2" fill="currentColor" />
        <circle cx="10" cy="18" r="2" fill="currentColor" />
      </>
    ),
  },
];

function Icon({ children, className = "size-[18px]" }: { children: ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {children}
    </svg>
  );
}

export function AlfredMark({ size = "size-8" }: { size?: string }) {
  return <AlfredAvatar sizeClass={size} alt="" sizes="96px" loading="eager" />;
}

export type Appearance = "light" | "dark";

function subscribeAppearance(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/** Light is the default; dark is a per-device choice kept in localStorage. */
export function useAppearance(): [Appearance, (next: Appearance) => void] {
  const current = useSyncExternalStore(
    subscribeAppearance,
    () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"),
    () => "light" as const,
  );
  const set = (next: Appearance) => {
    void serializeBrowserPreferenceWrite(() => {
      if (next === "dark") document.documentElement.dataset.theme = "dark";
      else delete document.documentElement.dataset.theme;
      try { localStorage.setItem("alfred-appearance", next); }
      catch { /* Private browsing can block storage; the choice still applies for this visit. */ }
    }).catch(() => { /* A failed coordination request leaves the current choice unchanged. */ });
  };
  return [current, set];
}

function subscribePrivacy(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-privacy"] });
  return () => observer.disconnect();
}

/** Whether monetary amounts are masked across the UI so you can open Alfred in public. */
export function usePrivacyMask(): [boolean, (next: boolean) => void] {
  const masked = useSyncExternalStore(
    subscribePrivacy,
    () => document.documentElement.dataset.privacy === "masked",
    () => false,
  );
  const set = (next: boolean) => {
    void serializeBrowserPreferenceWrite(() => {
      if (next) document.documentElement.dataset.privacy = "masked";
      else delete document.documentElement.dataset.privacy;
      try {
        if (next) localStorage.setItem("alfred-privacy", "masked");
        else localStorage.removeItem("alfred-privacy");
      } catch { /* Private browsing can block storage; the choice still applies for this visit. */ }
    }).catch(() => { /* A failed coordination request leaves the current choice unchanged. */ });
  };
  return [masked, set];
}

export function PrivacyToggle() {
  const [masked, setMasked] = usePrivacyMask();
  return (
    <button
      type="button"
      onClick={() => setMasked(!masked)}
      aria-pressed={masked}
      aria-label={masked ? "Reveal amounts" : "Hide amounts"}
      title={masked ? "Reveal amounts" : "Hide amounts"}
      className={buttonClassName({ variant: "ghost", size: "sm", className: "alfred-ui-privacy" })}
    >
      <Icon className="size-4">
        {masked ? (
          <>
            <path d="M3 3l18 18" />
            <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
            <path d="M9.9 5.1A10.7 10.7 0 0 1 12 5c5 0 9.3 3.1 11 7-1 2.2-2.7 4.1-4.8 5.3M6.2 6.2C4.3 7.4 2.8 9.5 1 12c1.7 3.9 6 7 11 7 1.6 0 3.1-.3 4.5-.9" />
          </>
        ) : (
          <>
            <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
            <circle cx="12" cy="12" r="3" />
          </>
        )}
      </Icon>
      <span className="hidden sm:inline">{masked ? "Amounts hidden" : "Hide amounts"}</span>
    </button>
  );
}

function Initial({ name, className = "size-8" }: { name: string; className?: string }) {
  const letter = name.trim().charAt(0).toUpperCase();
  return (
    <span className={`grid shrink-0 place-items-center rounded-full border border-line bg-surface-2 text-xs font-semibold text-muted ${className}`} aria-hidden="true">
      {letter || (
        <Icon className="size-4">
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21a8 8 0 0 1 16 0" />
        </Icon>
      )}
    </span>
  );
}

/** Authenticated application frame: top bar navigation on wider screens, a bottom tab bar on phones. */
export function AppShell({ current, name, fill = false, headerAction, children }: {
  current: Section;
  name: string;
  fill?: boolean;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  const [appearance, setAppearance] = useAppearance();
  const chat = current === "chat";
  const viewport = useChatViewport(chat);
  return <div ref={viewport} className={`alfred-app${chat ? " alfred-app-chat alfred-chat-viewport" : ""}`}>
    <div className={`alfred-ui-pageShell${fill || chat ? " alfred-ui-fill" : ""}`}>
      <a className="alfred-ui-skip" href="#app-content">Skip to content</a>
      <header className={`alfred-ui-header${chat ? " alfred-ui-chatHeader" : ""}`}>
        <div className="alfred-ui-headerInner">
          <Link href="/" className="alfred-ui-brand"><span>Alfred</span></Link>
          {/* Wider screens navigate from the top bar; phones use the bottom tab bar below. */}
          <nav className="alfred-ui-topNav" aria-label="Main">
            {NAV.map((item) => <Link key={item.section} href={item.href} aria-current={current === item.section ? "page" : undefined}><Icon className="size-4">{item.icon}</Icon><span>{item.label}</span></Link>)}
          </nav>
          <div className="alfred-ui-headerActions">
            <PrivacyToggle/>
            {headerAction}
            <button type="button" className={buttonClassName({ variant: "ghost", size: "sm", className: "alfred-ui-themeButton" })} onClick={() => setAppearance(appearance === "light" ? "dark" : "light")} aria-label={`Switch to ${appearance === "light" ? "dark" : "light"} appearance`}>{appearance === "light" ? "Dark" : "Light"}</button>
            {!chat ? <Link href="/settings#profile" className="alfred-app-profile" aria-label={name ? `${name}: profile and settings` : "Profile and settings"} title="Profile and settings"><Initial name={name}/></Link> : null}
          </div>
        </div>
      </header>
      <main id="app-content" className="alfred-ui-main" tabIndex={-1}>{children}</main>
      <nav className="alfred-ui-dock" aria-label="Main (mobile)">
        {NAV.map((item) => <Link key={item.section} href={item.href} aria-current={current === item.section ? "page" : undefined}><Icon className="size-5">{item.icon}</Icon><span>{item.label}</span></Link>)}
      </nav>
    </div>
  </div>;
}
