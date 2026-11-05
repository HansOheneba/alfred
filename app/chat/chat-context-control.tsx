"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type Dispatch, type KeyboardEvent, type ReactNode, type SetStateAction } from "react";
import "./chat-navigation.css";

type Availability = "loading" | "available" | "hidden";
type ContextControl = {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  availability: Availability;
  setAvailable: (available: boolean) => void;
};
const ChatContextControl = createContext<ContextControl | null>(null);

/** One owned Chat frame shares its drawer with the active Chat navigation item. */
export function ChatContextProvider({ children, initiallyAvailable = false }: { children?: ReactNode; initiallyAvailable?: boolean }) {
  const [open, setOpen] = useState(false);
  const [availability, setAvailability] = useState<Availability>(initiallyAvailable ? "available" : "loading");
  const setAvailable = useCallback((available: boolean) => {
    setAvailability(available ? "available" : "hidden");
    if (!available) setOpen(false);
  }, []);
  const value = useMemo(() => ({ open, setOpen, availability, setAvailable }), [open, availability, setAvailable]);
  return <ChatContextControl.Provider value={value}>{children}</ChatContextControl.Provider>;
}

/** Standalone previews can still render Chat without requiring an application frame. */
export function useChatContextController(available: boolean): [boolean, Dispatch<SetStateAction<boolean>>] {
  const shared = useContext(ChatContextControl);
  const [localOpen, setLocalOpen] = useState(false);
  const setAvailable = shared?.setAvailable;
  useEffect(() => {
    setAvailable?.(available);
    return () => setAvailable?.(false);
  }, [available, setAvailable]);
  return [shared?.open ?? localOpen, shared?.setOpen ?? setLocalOpen];
}

export function ChatNavigationItem({ icon, placement }: { icon: ReactNode; placement: "header" | "dock" }) {
  const control = useContext(ChatContextControl);
  if (!control) return <Link href="/chat" aria-current="page">{icon}<span>Chat</span></Link>;
  return <ChatNavigationMenu control={control} icon={icon} placement={placement} />;
}

function ChatNavigationMenu({ control, icon, placement }: { control: ContextControl; icon: ReactNode; placement: "header" | "dock" }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const contextItem = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const available = control.availability === "available";
  const closeMenu = useCallback((restoreFocus = false) => {
    setMenuOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    (available ? contextItem.current : menu.current)?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) closeMenu(); };
    // The hidden breakpoint must never retain an open submenu when navigation moves.
    const resize = () => closeMenu();
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", resize);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", resize); };
  }, [menuOpen, available, closeMenu]);

  function menuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(true); }
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      (available ? contextItem.current : menu.current)?.focus();
    }
  }

  return <div ref={root} className={`alfred-chatNav alfred-chatNav--${placement}`} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) closeMenu();
  }}>
    <button ref={trigger} type="button" className="alfred-chatNav-trigger" aria-current="page" aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuOpen ? menuId : undefined} title="Chat options"
      onClick={() => setMenuOpen(open => !open)} onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (menuOpen) (available ? contextItem.current : menu.current)?.focus(); else setMenuOpen(true); }
        else if (event.key === "Escape" && menuOpen) { event.preventDefault(); closeMenu(true); }
        else if (event.key === "Tab" && menuOpen) closeMenu();
      }}>
      {icon}<span className="alfred-chatNav-label">Chat<svg className="alfred-chatNav-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></span>
    </button>
    {menuOpen ? <div ref={menu} id={menuId} role="menu" aria-label="Chat options" tabIndex={-1} className="alfred-chatNav-menu" onKeyDown={menuKeyDown}>
      <button ref={contextItem} type="button" role="menuitem" className="alfred-chatNav-context" aria-label="Show context" aria-haspopup="dialog" aria-controls={available ? "alfred-production-chat-contextSheet" : undefined} disabled={!available}
        title={available ? "Conversation context" : control.availability === "loading" ? "Context is available when Chat is ready" : "Context is available after you add money records"}
        onClick={() => {
          // The drawer restores focus to this stable trigger, not an unmounted menu item.
          closeMenu(true);
          control.setOpen(true);
        }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.01" /></svg><span>Context</span>
      </button>
    </div> : null}
  </div>;
}
