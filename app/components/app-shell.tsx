"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

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
    if (next) document.documentElement.dataset.privacy = "masked";
    else delete document.documentElement.dataset.privacy;
    try {
      if (next) localStorage.setItem("alfred-privacy", "masked");
      else localStorage.removeItem("alfred-privacy");
    } catch {
      // Private browsing can block storage; the choice still applies for this visit.
    }
  };
  return [masked, set];
}

function PrivacyToggle() {
  const [masked, setMasked] = usePrivacyMask();
  return (
    <button
      type="button"
      onClick={() => setMasked(!masked)}
      aria-pressed={masked}
      aria-label={masked ? "Reveal amounts" : "Hide amounts"}
      title={masked ? "Reveal amounts" : "Hide amounts"}
      className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-xs text-muted transition hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
    >
      <Icon className="size-3.5">
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

/** The sidebar's contents: shared by the desktop sidebar and the phone drawer. */
function NavContents({ current, name, onNavigate }: { current: Section; name: string; onNavigate?: () => void }) {
  return (
    <>
      <Link
        href="/"
        onClick={onNavigate}
        className="mx-3 mt-4 mb-6 flex items-center gap-2.5 rounded-xl px-2 py-1 focus-visible:outline-2 focus-visible:outline-accent"
      >
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
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] transition focus-visible:outline-2 focus-visible:outline-accent md:py-2 md:text-sm ${
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
        onClick={onNavigate}
        className="m-3 mt-auto flex items-center gap-3 rounded-xl border border-line px-3 py-2.5 transition hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
      >
        <Initial name={name} />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-ink">{name || "Your account"}</span>
          <span className="block text-xs text-faint">Profile & settings</span>
        </span>
      </Link>
    </>
  );
}

/** Desktop navigation: a fixed sidebar, as in most desktop finance apps. */
function Sidebar({ current, name }: { current: Section; name: string }) {
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-surface md:flex">
      <NavContents current={current} name={name} />
    </aside>
  );
}

/** Phone navigation: the sidebar slides in from the left, so the bottom edge stays free for the chat composer. */
function NavDrawer({ open, onClose, current, name }: { open: boolean; onClose: () => void; current: Section; name: string }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>("[aria-current='page'], a")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [open, onClose]);

  return (
    <div className={`fixed inset-0 z-50 md:hidden ${open ? "" : "pointer-events-none"}`} aria-hidden={!open}>
      <div className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0"}`} onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        inert={!open}
        className={`absolute inset-y-0 left-0 flex w-[min(18rem,85vw)] flex-col bg-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-2xl transition-transform duration-200 ease-out motion-reduce:transition-none ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <NavContents current={current} name={name} onNavigate={onClose} />
      </div>
    </div>
  );
}

/**
 * The signed-in frame. Desktop: a sidebar on the left and a slim title bar.
 * Phones: a top bar whose menu button opens the sidebar as a drawer. `fill`
 * hands the page a fixed-height area (for chat) instead of a scrolling one.
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
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  return (
    // `relative` on the frame and the scroll area keeps positioned children (screen-reader labels,
    // chart tooltips) inside them; otherwise they size the page and the sidebar scrolls with it.
    <div className="relative flex h-dvh w-full overflow-hidden bg-bg">
      <Sidebar current={current} name={name} />
      <NavDrawer open={menuOpen} onClose={closeMenu} current={current} name={name} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="box-content flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-2 pt-[env(safe-area-inset-top)] md:gap-3 md:bg-bg md:px-8">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label="Open menu"
            aria-expanded={menuOpen}
            className="grid size-10 place-items-center rounded-full text-ink transition hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent md:hidden"
          >
            <Icon className="size-[22px]">
              <path d="M4 7h16M4 12h16M4 17h10" />
            </Icon>
          </button>
          <h1 className="text-[17px] font-semibold tracking-tight text-ink md:text-[15px]">{title}</h1>
          <div className="ml-auto flex items-center gap-2 pr-2 md:pr-0">
            <PrivacyToggle />
            {headerAction}
          </div>
        </header>
        <main className={`relative flex min-h-0 min-w-0 flex-1 flex-col ${fill ? "" : "overflow-y-auto overscroll-contain"}`}>{children}</main>
      </div>
    </div>
  );
}
