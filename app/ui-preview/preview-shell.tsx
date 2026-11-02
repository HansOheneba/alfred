"use client";

import Link from "next/link";
import { createContext, useContext, type ReactNode } from "react";

import { useChatViewport } from "@/app/components/chat-viewport";
import { AlfredMark, usePrivacyMask, type Section } from "@/app/components/app-shell";

export const PREVIEW_NAV: { section: Section; href: string; label: string; icon: ReactNode }[] = [
  { section: "chat", href: "/ui-preview/chat", label: "Chat", icon: <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4A1.5 1.5 0 0 1 4 14.5z" /> },
  { section: "dashboard", href: "/ui-preview", label: "Overview", icon: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></> },
  { section: "accounts", href: "/ui-preview/accounts", label: "Accounts", icon: <path d="M3 7h16a2 2 0 0 1 2 2v10H5a2 2 0 0 1-2-2V7Zm0 0V5a2 2 0 0 1 2-2h12v4m0 5h4m-4 0v3h4"/> },
  { section: "investments", href: "/ui-preview/investments", label: "Investments", icon: <path d="m3 18 6-6 4 4 8-11m-6 0h6v6"/> },
  { section: "settings", href: "/ui-preview/settings", label: "Settings", icon: <><path d="M3 6h18M3 12h18M3 18h18"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/></> },
];

export function PreviewIcon({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}

const PreviewToolsContext = createContext<ReactNode>(null);

export function PreviewChatTools() { return <>{useContext(PreviewToolsContext)}</>; }

export function PreviewShell({ section, tools, children }: { section: Section; tools: ReactNode; children: ReactNode }) {
  const [masked, setMasked] = usePrivacyMask();
  const chat = section === "chat";
  const viewportRef = useChatViewport(chat);
  const title = PREVIEW_NAV.find((item) => item.section === section)?.label;
  return (
    <div ref={viewportRef} className={`alfred-ui-pageShell${chat ? " alfred-chat-viewport" : ""}`}>
      <a className="alfred-ui-skip" href="#preview-content">Skip to content</a>
      {!chat ? <header className="alfred-ui-header">
        <div className="alfred-ui-headerInner">
          <Link href="/ui-preview" className="alfred-ui-brand"><AlfredMark size="size-8"/><span>Alfred</span></Link>
          <span className="alfred-ui-pageTitle">{title}</span>
          <div className="alfred-ui-headerActions">
            <button type="button" className="alfred-ui-privacy" onClick={() => setMasked(!masked)} aria-label={masked ? "Reveal amounts" : "Hide amounts"} aria-pressed={masked} title={masked ? "Reveal amounts" : "Hide amounts"}>
              <PreviewIcon><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>{masked ? <path d="M3 3l18 18"/> : null}</PreviewIcon>
              <span>{masked ? "Amounts hidden" : "Hide amounts"}</span>
            </button>
            {tools}
          </div>
        </div>
      </header> : null}
      <PreviewToolsContext.Provider value={tools}><main id="preview-content" className="alfred-ui-main" tabIndex={-1}>{children}</main></PreviewToolsContext.Provider>
      <nav className="alfred-ui-dock" aria-label="Main">
        {PREVIEW_NAV.map((item) => <Link key={item.section} href={item.href} aria-current={section === item.section ? "page" : undefined} prefetch={false}><PreviewIcon>{item.icon}</PreviewIcon><span>{item.label}</span></Link>)}
      </nav>
    </div>
  );
}
