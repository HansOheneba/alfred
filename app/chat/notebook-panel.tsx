"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

import type { AboutNote } from "@/lib/notebook/store";
import type { KnownPerson } from "@/lib/web/people";

import "./notebook-panel.css";

export type ChatNotebookData = { people: KnownPerson[]; about: AboutNote[]; error?: string };

function subscribeLocation(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}

/** The URL keeps saved Notebook links useful without adding another main destination. */
export function useNotebookPanel() {
  const query = useSyncExternalStore(subscribeLocation, () => window.location.search, () => "");
  const open = new URLSearchParams(query).get("panel") === "notebook";
  const setOpen = useCallback((nextOpen: boolean) => {
    const url = new URL(window.location.href);
    if (nextOpen) url.searchParams.set("panel", "notebook");
    else url.searchParams.delete("panel");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);
  return { open, setOpen };
}

export function NotebookIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="6" y="3" width="14" height="18" rx="2"/><path d="M4 7h4M4 12h4M4 17h4M11 8h5m-5 4h5"/></svg>;
}

/** Native dialog provides modal semantics, Escape and return-to-trigger behavior. */
export function NotebookPanel({ open, onClose, children, demo = false }: { open: boolean; onClose: () => void; children: ReactNode; demo?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const restoreFocus = useCallback(() => {
    const previous = previousFocus.current;
    const target = previous?.isConnected && previous !== document.body ? previous : document.querySelector<HTMLButtonElement>('button[aria-controls="alfred-chat-notebook"]');
    target?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      node.showModal();
    }
    else if (!open && node.open) {
      node.close();
      restoreFocus();
    }
  }, [open, restoreFocus]);

  return <dialog
    ref={dialog}
    id="alfred-chat-notebook"
    className="alfred-notebook-panel"
    aria-labelledby="alfred-notebook-title"
    onKeyDown={(event) => {
      if (event.key !== "Tab") return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex="0"]')].filter((node) => node.getClientRects().length > 0);
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
    }}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClose={() => { restoreFocus(); if (open) onClose(); }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}
  >
    <div className="alfred-notebook-panelHeader">
      <div className="alfred-notebook-panelIdentity"><span><NotebookIcon/></span><div><h2 id="alfred-notebook-title">Notebook</h2><p>What Alfred remembers for your conversations</p></div></div>
      <button type="button" className="alfred-notebook-close" aria-label="Close Notebook" onClick={onClose} autoFocus><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button>
    </div>
    <div className="alfred-notebook-panelBody">{children}</div>
    <div className="alfred-notebook-panelFooter"><span>{demo ? "Synthetic notes · Saved only in this browser" : "You can also tell Alfred these things in chat."}</span><button type="button" onClick={onClose}>Back to chat <span aria-hidden="true">↗</span></button></div>
  </dialog>;
}
