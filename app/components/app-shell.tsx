"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import { AlfredAvatar } from "@/app/components/alfred-avatar";

export type Section = "chat" | "dashboard" | "settings";

const NAV: { section: Section; href: string; label: string; icon: ReactNode }[] = [
  {
    section: "chat",
    href: "/",
    label: "Chat",
    icon: <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z" />,
  },
  {
    section: "dashboard",
    href: "/dashboard",
    label: "Dashboard",
    icon: <path d="M4 20V10m6 10V4m6 16v-7m4 7H3" />,
  },
  {
    section: "settings",
    href: "/settings",
    label: "Settings",
    icon: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
      </>
    ),
  },
];

function Icon({ children, className = "size-[18px]" }: { children: ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {children}
    </svg>
  );
}

export function AlfredMark({ size = "size-8" }: { size?: string }) {
  return <AlfredAvatar sizeClass={size} alt="" sizes="96px" loading="eager" />;
}

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

function ThemeToggle() {
  const light = useSyncExternalStore(
    subscribeTheme,
    () => document.documentElement.dataset.theme === "light",
    () => false,
  );
  const toggle = () => {
    const next = !light;
    if (next) document.documentElement.dataset.theme = "light";
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem("alfred-theme", next ? "light" : "dark");
    } catch {
      // Private browsing can block storage; the toggle still works for this visit.
    }
  };
  return (
    <button
      type="button"
      onClick={toggle}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-muted transition hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-gold"
      aria-label={light ? "Switch to dark mode" : "Switch to light mode"}
    >
      <Icon>{light ? <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /> : <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4" /></>}</Icon>
      {light ? "Dark mode" : "Light mode"}
    </button>
  );
}

function Sidebar({ current, name, onNavigate }: { current: Section; name: string; onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col gap-6 p-3">
      <Link href="/" onClick={onNavigate} className="flex items-center gap-3 rounded-xl px-2 py-1.5 focus-visible:outline-2 focus-visible:outline-gold">
        <AlfredMark />
        <span className="font-display text-[15px] font-medium tracking-tight">Alfred</span>
      </Link>
      <nav className="flex flex-col gap-1" aria-label="Main">
        {NAV.map((item) => {
          const active = item.section === current;
          return (
            <Link
              key={item.section}
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition focus-visible:outline-2 focus-visible:outline-gold ${
                active ? "bg-surface-2 text-ink" : "text-muted hover:bg-surface-2 hover:text-ink"
              }`}
            >
              <Icon className={`size-[18px] ${active ? "text-gold" : ""}`}>{item.icon}</Icon>
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto flex flex-col gap-1 border-t border-line pt-3">
        <ThemeToggle />
        <form action="/api/sign-out" method="post">
          <button
            type="submit"
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-muted transition hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-gold"
          >
            <Icon>
              <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11" />
            </Icon>
            Sign out
          </button>
        </form>
        {name ? <p className="truncate px-3 pt-2 text-xs text-faint">Signed in as {name}</p> : null}
      </div>
    </div>
  );
}

/**
 * The signed-in frame: a sidebar on desktop and a top bar with a slide-out
 * menu on phones. `fill` gives the page a fixed-height area for chat.
 */
export function AppShell({
  current,
  name,
  fill = false,
  headerAction,
  children,
}: {
  current: Section;
  name: string;
  fill?: boolean;
  /** Extra control on the right of the phone top bar. */
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const title = NAV.find((item) => item.section === current)?.label ?? "Alfred";

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <div className={`flex w-full bg-bg ${fill ? "h-dvh overflow-hidden" : "min-h-dvh"}`}>
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 border-r border-line bg-surface md:block">
        <Sidebar current={current} name={name} />
      </aside>

      {menuOpen ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-black/60" onClick={() => setMenuOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-line bg-surface pt-[env(safe-area-inset-top)] shadow-2xl">
            <Sidebar current={current} name={name} onNavigate={() => setMenuOpen(false)} />
          </aside>
        </div>
      ) : null}

      <div className={`flex min-w-0 flex-1 flex-col ${fill ? "h-dvh" : ""}`}>
        <header className="sticky top-0 z-30 flex shrink-0 items-center gap-3 border-b border-line bg-bg/90 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] backdrop-blur md:hidden">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            className="grid size-9 place-items-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-gold"
            aria-label="Open menu"
            aria-expanded={menuOpen}
          >
            <Icon>
              <path d="M4 7h16M4 12h16M4 17h16" />
            </Icon>
          </button>
          <AlfredMark size="size-7" />
          <span className="text-sm font-medium">{title}</span>
          {headerAction ? <span className="ml-auto">{headerAction}</span> : null}
        </header>
        <main className={`flex min-w-0 flex-1 flex-col ${fill ? "min-h-0" : ""}`}>{children}</main>
      </div>
    </div>
  );
}
