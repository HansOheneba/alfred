"use client";

import type { ReactNode } from "react";
import { AppShell } from "@/app/components/app-shell";
import { ChatContextProvider } from "@/app/chat/chat-context-control";

/** Keep context state within the current owned route; the draft provider stays above Suspense. */
export function ChatShell({ name, contextAvailable = false, children, ownerId }: { name: string; contextAvailable?: boolean; children?: ReactNode; ownerId?: string }) {
  return <ChatContextProvider initiallyAvailable={contextAvailable}><AppShell current="chat" name={name} ownerId={ownerId} fill>{children}</AppShell></ChatContextProvider>;
}
