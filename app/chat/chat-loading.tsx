"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { buttonClassName } from "@/app/components/button-styles";
import { useChatDraft, useChatDraftFocus } from "@/app/chat/chat-draft";

import "./chat.css";

/** Reserve the same space as the conversation without inventing saved messages. */
export function ChatHistorySkeleton() {
  return <div className="alfred-production-chat-historySkeleton" role="status" aria-busy="true" aria-label="Loading your conversation">
    <span className="sr-only">Loading your conversation…</span>
    <div className="alfred-production-chat-skeletonMessages" aria-hidden="true">
      <div className="alfred-production-chat-skeletonAssistant">
        <div className="alfred-production-chat-skeletonIdentity"><i /><span /></div>
        <div className="alfred-production-chat-skeletonCopy"><span /><span /><span /></div>
      </div>
      <div className="alfred-production-chat-skeletonUser"><span /><i /></div>
      <div className="alfred-production-chat-skeletonAssistant">
        <div className="alfred-production-chat-skeletonIdentity"><i /><span /></div>
        <div className="alfred-production-chat-skeletonCopy"><span /><span /></div>
      </div>
    </div>
  </div>;
}

export function ChatContextSkeleton() {
  return <div className="alfred-production-chat-contextSkeleton" role="status" aria-busy="true" aria-label="Loading your financial summary">
    <span className="sr-only">Loading your financial summary…</span>
    <div aria-hidden="true"><section><i /><strong /><span /><span /></section><section><i /><div><span /><span /></div><div><span /><span /></div><div><span /><span /></div></section><section><i /><span /><span /></section></div>
  </div>;
}

/** A draft is safe before sign-in; sending waits for the owned conversation. */
export function ChatLoadingState() {
  const [text, setText] = useChatDraft("", null);
  const draftFocus = useChatDraftFocus();
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!input.current) return;
    input.current.style.height = text ? "auto" : "";
    if (text) input.current.style.height = `${Math.max(44, Math.min(input.current.scrollHeight, 160))}px`;
  }, [text]);
  return <div className="alfred-production-chat">
    <section className="alfred-production-chat-conversation" aria-label="Chat with Alfred">
      <h1 className="sr-only">Chat</h1>
      <div className="alfred-production-chat-scroll"><ChatHistorySkeleton /></div>
      <div className="alfred-production-chat-composeArea">
        <div className="alfred-production-chat-composer" aria-label="Message composer loading">
          <div className="alfred-production-chat-composerRow">
            <button className={buttonClassName({ variant: "ghost", size: "icon" })} type="button" disabled aria-label="Attach a screenshot"><LoadingIcon><path d="M12 5v14M5 12h14" /></LoadingIcon></button>
            <label className="sr-only" htmlFor="alfred-loading-message">Message Alfred</label>
            <textarea ref={input} id="alfred-loading-message" value={text} onChange={event => { setText(event.target.value); draftFocus.remember(event.currentTarget); }} onFocus={event => draftFocus.remember(event.currentTarget)} onSelect={event => draftFocus.remember(event.currentTarget)} onBlur={draftFocus.forget} maxLength={2000} rows={1} placeholder="Tell me what happened…" aria-describedby="alfred-loading-compose-hint" />
            <button className={buttonClassName({ variant: "primary", size: "icon", className: "alfred-production-chat-send" })} type="button" disabled aria-label="Send"><LoadingIcon><path d="M12 19V5m-6 6 6-6 6 6" /></LoadingIcon></button>
          </div>
          <span id="alfred-loading-compose-hint" className="sr-only">You can draft your message while Chat loads. Sending will be available when your conversation is ready.</span>
        </div>
      </div>
    </section>
  </div>;
}

function LoadingIcon({ children }: { children: ReactNode }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}
