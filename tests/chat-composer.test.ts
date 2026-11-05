import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatPanel, resizeChatComposer } from "@/app/chat/chat-panel";
import { ChatShell } from "@/app/chat/chat-shell";

describe("compact Chat composer", () => {
  it("opens context directly from the main header and keeps Chat navigation and the composer independent", () => {
    const markup = renderToStaticMarkup(createElement(ChatShell, { name: "Sample", contextAvailable: true }, createElement(ChatPanel, { ownerId: "fictional-owner", name: "Sample", initialMessages: [] })));
    const header = markup.match(/<header class="alfred-ui-header alfred-ui-chatHeader">([\s\S]*?)<\/header>/)?.[1];
    const composer = markup.match(/<form class="alfred-production-chat-composer"[\s\S]*?<\/form>/)?.[0];
    expect(header).toContain('aria-label="Show conversation context" aria-haspopup="dialog" aria-expanded="false"');
    expect(header).toContain('aria-controls="alfred-production-chat-contextSheet"');
    expect(markup.match(/aria-label="Show conversation context"/g)).toHaveLength(1);
    expect(markup.match(/<a(?=[^>]*href="\/chat")(?=[^>]*aria-current="page")[^>]*>/g)).toHaveLength(2);
    expect(markup).not.toContain('aria-haspopup="menu"');
    expect(markup).not.toContain("alfred-chatNav-trigger");
    expect(markup).toContain('<h1 class="sr-only">Chat</h1>');
    expect(markup).not.toContain("alfred-production-chat-toolbar");
    expect(markup).not.toContain('role="menuitem"');
    expect(composer).toContain('aria-label="Attach a screenshot"');
    expect(composer).toContain('rows="1"');
    expect(composer).toContain('enterKeyHint="send"');
    expect(composer).toContain('aria-label="Send"');
    expect(composer).toContain("Enter to send · Shift + Enter for a new line");
    expect(composer).not.toContain("Show conversation context");
  });

  it("retains an available context sheet destination and preserves a supplied draft", () => {
    const markup = renderToStaticMarkup(createElement(ChatPanel, { ownerId: "fictional-owner", name: "Sample", initialMessages: [], initialQuestion: "Review this draft" }));
    expect(markup).toContain('id="alfred-production-chat-contextSheet"');
    expect(markup).toContain('aria-label="Close context"');
    expect(markup).toContain(">Review this draft</textarea>");
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*aria-label="Send"/);
  });

  it("resets a cleared draft without measuring layout", () => {
    const node = { value: "", style: { height: "160px" }, get scrollHeight(): number { throw new Error("An empty draft must not be measured"); } };
    resizeChatComposer(node);
    expect(node.style.height).toBe("");
  });

  it.each([{ measured: 20, height: "44px" }, { measured: 68, height: "68px" }, { measured: 1200, height: "160px" }])("fits a draft measured at $measured px without exceeding the composer limit", ({ measured, height }) => {
    const node = { value: "A fictional draft", scrollHeight: measured, style: { height: "" } };
    resizeChatComposer(node);
    expect(node.style.height).toBe(height);
  });

  it("remeasures after removing lines so a tall draft shrinks again", () => {
    const style = { height: "160px" };
    const node = { value: "Shorter draft", get scrollHeight() { expect(style.height).toBe("auto"); return 44; }, style };
    resizeChatComposer(node);
    expect(style.height).toBe("44px");
  });
});
