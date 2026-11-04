"use client";

import { createContext, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useSearchParams } from "next/navigation";
import { chatDraftScope } from "@/app/chat/chat-draft-scope";

type ChatDraft = { ownerId: string | null; text: string | null; scope?: string | null };
type DraftFocus = { scope: string | null; start: number; end: number };
const DraftContext = createContext<{ draft: ChatDraft; update: Dispatch<SetStateAction<ChatDraft>>; rememberFocus: (next: DraftFocus | null) => void; takeFocus: (scope: string | null) => DraftFocus | null } | null>(null);

/** This draft lives only for this Chat page mount, including its sign-in shell. */
export function ChatDraftProvider({ children }: { children: ReactNode }) {
  const [draft, update] = useState<ChatDraft>({ ownerId: null, text: null });
  const focus = useRef<DraftFocus | null>(null);
  const rememberFocus = useCallback((next: DraftFocus | null) => { focus.current = next; }, []);
  const takeFocus = useCallback((scope: string | null) => {
    const previous = focus.current;
    focus.current = null;
    return previous?.scope == null || previous.scope === scope ? previous : null;
  }, []);
  const context = useMemo(() => ({ draft, update, rememberFocus, takeFocus }), [draft, rememberFocus, takeFocus]);
  return <DraftContext.Provider value={context}><Suspense fallback={null}><DraftRouteScope /></Suspense>{children}</DraftContext.Provider>;
}

function DraftRouteScope() {
  const parameters = useSearchParams();
  const update = useContext(DraftContext)!.update;
  const scope = chatDraftScope(parameters.getAll("question"), parameters.getAll("payment"));
  useEffect(() => { update(draft => scopedChatDraft(draft, scope)); }, [scope, update]);
  return null;
}

export function scopedChatDraft(draft: ChatDraft, scope: string): ChatDraft {
  return draft.scope === scope ? draft : { ...draft, scope, text: draft.scope == null ? draft.text : null };
}

/** The first owner adopts a loading draft; another owner never receives it. */
export function ownedChatDraft(draft: ChatDraft, ownerId: string): ChatDraft {
  return draft.ownerId === ownerId ? draft : { ...draft, ownerId, text: draft.ownerId === null ? draft.text : "" };
}

export function useChatDraft(initialText: string, ownerId: string | null, scope?: string): [string, Dispatch<SetStateAction<string>>] {
  const shared = useContext(DraftContext);
  const update = shared?.update;
  const [localText, updateLocal] = useState(initialText);
  useEffect(() => {
    if (ownerId && update) update(draft => ownedChatDraft(scope ? scopedChatDraft(draft, scope) : draft, ownerId));
  }, [ownerId, scope, update]);
  const setText = useCallback<Dispatch<SetStateAction<string>>>(next => {
    if (!update) { updateLocal(next); return; }
    update(draft => {
      // An unknown session can start a fresh draft, but must never read or
      // append to text belonging to the previously authenticated account.
      if (!ownerId && draft.ownerId) return { ...draft, ownerId: null, text: typeof next === "function" ? next("") : next };
      if (ownerId && draft.ownerId && draft.ownerId !== ownerId) return draft;
      if (scope && draft.scope && draft.scope !== scope) return draft;
      const previous = draft.text ?? initialText;
      return { ...draft, text: typeof next === "function" ? next(previous) : next };
    });
  }, [initialText, ownerId, scope, update]);
  const text = shared ? shared.draft.ownerId && shared.draft.ownerId !== ownerId ? "" : scope && shared.draft.scope && shared.draft.scope !== scope ? initialText : shared.draft.text ?? initialText : localText;
  return [text, setText];
}

/** Restore focus only when an actively edited loading field is being replaced. */
export function useChatDraftFocus(scope?: string) {
  const shared = useContext(DraftContext);
  const rememberFocus = shared?.rememberFocus;
  const takeFocus = shared?.takeFocus;
  const currentScope = scope ?? shared?.draft.scope ?? null;
  const remember = useCallback((node: HTMLTextAreaElement) => {
    rememberFocus?.({ scope: currentScope, start: node.selectionStart, end: node.selectionEnd });
  }, [currentScope, rememberFocus]);
  const forget = useCallback(() => { rememberFocus?.(null); }, [rememberFocus]);
  const restore = useCallback((node: HTMLTextAreaElement) => {
    const previous = takeFocus?.(currentScope);
    if (!previous) return false;
    node.focus({ preventScroll: true });
    node.setSelectionRange(Math.min(previous.start, node.value.length), Math.min(previous.end, node.value.length));
    return true;
  }, [currentScope, takeFocus]);
  return { remember, forget, restore };
}
