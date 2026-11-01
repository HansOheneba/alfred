"use client";

import Link from "next/link";
import { useSyncExternalStore, type ReactNode } from "react";

import { AlfredAvatar } from "@/app/components/alfred-avatar";

export type Section = "chat" | "dashboard" | "investments" | "review" | "notebook" | "settings";

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
    section: "investments",
    href: "/investments",
    label: "Investments",
    icon: <path d="m3 18 6-6 4 4 8-11m-6 0h6v6" />,
  },
  {
    section: "review",
    href: "/review",
    label: "Review",
    icon: <path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4" />,
  },
  {
    section: "notebook",
    href: "/notebook",
    label: "Notebook",
    icon: (
      <>
        <path d="M6 3h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6z" />
        <path d="M6 3v18M10 8h6M10 12h5" />
      </>
    ),
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
    if (next === "dark") document.documentElement.dataset.theme = "dark";
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem("alfred-appearance", next);
    } catch {
      // Private browsing can block storage; the choice still applies for this visit.
    }
  };
  return [current, set];
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

/** Desktop navigation: a fixed sidebar, as in most desktop finance apps. */
function Sidebar({ current, name }: { current: Section; name: string }) {
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-surface md:flex">
      <Link href="/" className="mx-3 mt-4 mb-6 flex items-center gap-2.5 rounded-xl px-2 py-1 focus-visible:outline-2 focus-visible:outline-accent">
        <AlfredMark size="size-8" />
        <span className="text-[17px] font-semibold tracking-tight">Alfred</span>
      </Link>
      <nav aria-label="Main" className="flex flex-col gap-0.5 px-3">
        {NAV.map((item) => {
          const active = item.section === current;
          return (
            <Link
              key={item.section}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition focus-visible:outline-2 focus-visible:outline-accent ${
                active ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-surface-2 hover:text-ink"
              }`}
            >
              <Icon>{item.icon}</Icon>
              {item.label}
            </Link>
          );
        })}
      </nav>
      <Link
        href="/settings#profile"
        className="m-3 mt-auto flex items-center gap-3 rounded-xl border border-line px-3 py-2.5 transition hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
      >
        <Initial name={name} />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-ink">{name || "Your account"}</span>
          <span className="block text-xs text-faint">Profile & settings</span>
        </span>
      </Link>
    </aside>
  );
}

/** Phone navigation: a tab bar in its own row at the bottom, so it never covers the chat composer. */
function TabBar({ current }: { current: Section }) {
  return (
    <nav aria-label="Main" className="shrink-0 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
      <div className="mx-auto flex max-w-lg items-stretch justify-around">
        {NAV.map((item) => {
          const active = item.section === current;
          return (
            <Link
              key={item.section}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex flex-1 flex-col items-center gap-1 px-1 py-2 text-[11px] font-medium transition focus-visible:outline-2 focus-visible:outline-accent ${
                active ? "text-accent" : "text-muted hover:text-ink"
              }`}
            >
              <span className={`grid place-items-center rounded-full px-4 py-1 ${active ? "bg-accent-soft" : ""}`}>
                <Icon className="size-5">{item.icon}</Icon>
              </span>
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

/**
 * The signed-in frame. Desktop: a sidebar on the left and a slim title bar.
 * Phones: a top bar and a bottom tab bar. `fill` hands the page a
 * fixed-height area (for chat) instead of a scrolling one.
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
  /** Extra control on the right of the title bar. */
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  const title = NAV.find((item) => item.section === current)?.label ?? "Alfred";

  return (
    // `relative` on the frame and the scroll area keeps positioned children (screen-reader labels,
    // chart tooltips) inside them; otherwise they size the page and the sidebar scrolls with it.
    <div className="relative flex h-dvh w-full overflow-hidden bg-bg">
      <Sidebar current={current} name={name} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="box-content flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-4 pt-[env(safe-area-inset-top)] md:bg-bg md:px-8">
          <Link href="/" className="flex items-center gap-2.5 rounded-xl focus-visible:outline-2 focus-visible:outline-accent md:hidden">
            <AlfredMark size="size-8" />
            <span className="text-[17px] font-semibold tracking-tight">Alfred</span>
          </Link>
          <span className="text-sm text-faint md:hidden" aria-hidden="true">
            /
          </span>
          <h1 className="text-sm font-medium text-muted md:text-[15px] md:font-semibold md:text-ink">{title}</h1>
          <div className="ml-auto flex items-center gap-2">
            {headerAction}
            <Link href="/settings#profile" aria-label="Your profile" className="rounded-full focus-visible:outline-2 focus-visible:outline-accent md:hidden">
              <Initial name={name} />
            </Link>
          </div>
        </header>
        <main className={`relative flex min-h-0 min-w-0 flex-1 flex-col ${fill ? "" : "overflow-y-auto overscroll-contain"}`}>{children}</main>
        <TabBar current={current} />
      </div>
    </div>
  );
}
