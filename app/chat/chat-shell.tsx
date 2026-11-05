"use client";

import type { ReactNode } from "react";
import { AppShell } from "@/app/components/app-shell";
import { ChatContextProvider } from "@/app/chat/chat-context-control";

/** Keep context state within the current owned route; the draft provider stays above Suspense. */
export function ChatShell({ name, contextAvailable = false, children }: { name: string; contextAvailable?: boolean; children?: ReactNode }) {
  return <ChatContextProvider initiallyAvailable={contextAvailable}><AppShell current="chat" name={name} fill>{children}</AppShell></ChatContextProvider>;
}
