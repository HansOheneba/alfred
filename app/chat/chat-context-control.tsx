"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { buttonClassName } from "@/app/components/button-styles";
import "./chat-context-control.css";

type Availability = "loading" | "available" | "hidden";
type ContextControl = {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  availability: Availability;
  setAvailable: (available: boolean) => void;
};
const ChatContextControl = createContext<ContextControl | null>(null);

/** One owned Chat frame shares its drawer with the header context control. */
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

export function ChatContextButton() {
  const control = useContext(ChatContextControl);
  if (!control || control.availability === "hidden") return null;
  const available = control.availability === "available";
  return <button type="button" className={buttonClassName({ variant: "ghost", size: "sm", className: "alfred-headerContext" })}
    aria-label="Show conversation context" aria-haspopup="dialog" aria-expanded={control.open}
    aria-controls={available ? "alfred-production-chat-contextSheet" : undefined} aria-busy={!available || undefined} disabled={!available}
    title={available ? "Conversation context" : "Context is available when Chat is ready"} onClick={() => control.setOpen(true)}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16M6 8h5M6 12h5" /></svg>
    <span>Context</span>
  </button>;
}
