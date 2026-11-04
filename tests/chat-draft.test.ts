import { afterEach, describe, expect, it, vi } from "vitest";

import { ownedChatDraft, scopedChatDraft, useChatDraft, useChatDraftFocus } from "@/app/chat/chat-draft";
import { chatDraftScope } from "@/app/chat/chat-draft-scope";

type Draft = { ownerId: string | null; text: string | null; scope?: string | null };
type Focus = { scope: string | null; start: number; end: number };
const hooks = vi.hoisted(() => ({ active: false, shared: null as { draft: Draft; update: (next: (draft: Draft) => Draft) => void; rememberFocus: (next: Focus | null) => void; takeFocus: (scope: string | null) => Focus | null } | null, effects: [] as (() => void)[] }));
vi.mock("react", async load => {
  const react = await load<typeof import("react")>();
  return { ...react,
    useContext: (...args: Parameters<typeof react.useContext>) => hooks.active ? hooks.shared : react.useContext(...args),
    useState: <T>(initial: T) => hooks.active ? [initial, vi.fn()] : react.useState(initial),
    useEffect: (...args: Parameters<typeof react.useEffect>) => { if (hooks.active) hooks.effects.push(args[0] as () => void); else react.useEffect(...args); },
    useCallback: <T>(read: T, dependencies: readonly unknown[]) => hooks.active ? read : react.useCallback(read as (...args: never[]) => unknown, dependencies),
  };
});

function pageDraft() {
  let focus: Focus | null = null;
  const shared = { draft: { ownerId: null, text: null } as Draft, update: (next: (draft: Draft) => Draft) => { shared.draft = next(shared.draft); }, rememberFocus: (next: Focus | null) => { focus = next; }, takeFocus: (scope: string | null) => { const previous = focus; focus = null; return previous?.scope == null || previous.scope === scope ? previous : null; } };
  hooks.shared = shared;
  function DraftReader(ownerId: string | null, initial = "", scope?: string) {
    hooks.active = true;
    try { return useChatDraft(initial, ownerId, scope); }
    finally { hooks.active = false; }
  }
  function commit() { for (const effect of hooks.effects.splice(0)) effect(); }
  return { shared, render: DraftReader, commit };
}
function FocusReader(scope?: string) { return useChatDraftFocus(scope); }
afterEach(() => { hooks.active = false; hooks.shared = null; hooks.effects = []; });

describe("the in-memory Chat loading draft", () => {
  it("scopes drafts to an explicit question/payment handoff so another linked question or payment gets a fresh provider", () => {
    const question = chatDraftScope("Record a loan", undefined);
    expect(chatDraftScope("Record a repayment", undefined)).not.toBe(question);
    expect(chatDraftScope(undefined, "payment-one")).not.toBe(question);
    expect(chatDraftScope(undefined, "payment-two")).not.toBe(chatDraftScope(undefined, "payment-one"));
    expect(chatDraftScope(["Record a loan"], [])).toBe(question);
  });

  it("shows a new handoff question immediately, then clears an old typed/sent draft without losing a same-handoff loading draft", () => {
    const page = pageDraft(), first = chatDraftScope("First question", undefined), second = chatDraftScope("Second question", undefined);
    page.shared.update(draft => scopedChatDraft(draft, first));
    page.render(null)[1]("Typing while first question loads");
    expect(page.render("owner", "First question", first)[0]).toBe("Typing while first question loads"); page.commit();
    const oldSetter = page.render("owner", "First question", first)[1]; oldSetter("");
    expect(page.render("owner", "Second question", second)[0]).toBe("Second question"); page.commit();
    oldSetter("Stale event from the first question");
    expect(page.render("owner", "Second question", second)[0]).toBe("Second question");
    const payment = chatDraftScope(undefined, "payment");
    expect(page.render("owner", "", payment)[0]).toBe(""); page.commit();
    expect(page.shared.draft.text).toBeNull();
  });
  it("hands typing from the loading composer to the first authenticated owner without replacing it with a linked question", () => {
    const page = pageDraft();
    page.render(null)[1]("A draft typed while Chat loads"); page.commit();
    expect(page.render("first-owner", "A question from Overview")[0]).toBe("A draft typed while Chat loads"); page.commit();
    expect(page.shared.draft).toEqual({ ownerId: "first-owner", text: "A draft typed while Chat loads" });
    expect(page.render("first-owner")[0]).toBe("A draft typed while Chat loads");
  });

  it("keeps a supplied question when the loading field was untouched, but respects an intentionally cleared loading draft", () => {
    const page = pageDraft();
    expect(page.render("first-owner", "Review this question")[0]).toBe("Review this question"); page.commit();
    page.render("first-owner", "Review this question")[1]("");
    expect(page.render("first-owner", "Review this question")[0]).toBe("");
  });

  it("hides and clears the previous owner's text immediately when the authenticated account changes", () => {
    const page = pageDraft();
    page.render("first-owner"); page.commit();
    const oldSetter = page.render("first-owner")[1]; oldSetter("Private first-owner draft");
    expect(page.render("second-owner", "Another linked question")[0]).toBe(""); page.commit();
    expect(page.shared.draft).toEqual({ ownerId: "second-owner", text: "" });
    oldSetter("A late first-owner update");
    expect(page.render("second-owner")[0]).toBe("");
    page.render("second-owner")[1]("The second owner's draft");
    expect(page.render("second-owner")[0]).toBe("The second owner's draft");
  });

  it("never exposes or appends to an owned draft in an unknown-session loading composer, while fresh typing still works", () => {
    const page = pageDraft();
    page.render("first-owner"); page.commit();
    page.render("first-owner")[1]("Private first-owner draft");
    expect(page.render(null)[0]).toBe(""); page.commit();
    expect(page.shared.draft.text).toBe("Private first-owner draft");
    expect(page.render("first-owner")[0]).toBe("Private first-owner draft"); page.commit();
    page.render(null)[1](previous => `${previous}New loading draft`);
    expect(page.render(null)[0]).toBe("New loading draft");
    expect(page.shared.draft.ownerId).toBeNull();
    expect(page.render("second-owner")[0]).toBe("New loading draft"); page.commit();
    expect(page.shared.draft).toEqual({ ownerId: "second-owner", text: "New loading draft" });
  });

  it("applies send/session clearing to the shared draft and starts a new page mount empty", () => {
    const page = pageDraft();
    page.render(null)[1]("Loading draft");
    page.render("first-owner"); page.commit();
    const [, setText] = page.render("first-owner");
    setText(previous => previous === "Loading draft" ? "" : previous);
    expect(page.render("first-owner")[0]).toBe("");
    expect(pageDraft().render(null)[0]).toBe("");
  });

  it("retains an adopted owner's draft during rechecks, and only adopts unowned text once", () => {
    const owned = { ownerId: "first-owner", text: "Draft" };
    expect(ownedChatDraft(owned, "first-owner")).toBe(owned);
    expect(ownedChatDraft(owned, "second-owner")).toEqual({ ownerId: "second-owner", text: "" });
  });

  it("restores the active loading caret once for the same handoff, but does not steal focus into a different handoff", () => {
    const page = pageDraft(), scope = chatDraftScope("Question", undefined);
    page.shared.update(draft => scopedChatDraft(draft, scope));
    hooks.active = true;
    const loading = FocusReader();
    const ready = FocusReader(scope);
    const elsewhere = FocusReader(chatDraftScope("Other question", undefined));
    hooks.active = false;
    const node = { value: "A loading draft", selectionStart: 3, selectionEnd: 7, focus: vi.fn(), setSelectionRange: vi.fn() } as unknown as HTMLTextAreaElement;
    loading.remember(node);
    expect(elsewhere.restore(node)).toBe(false);
    loading.remember(node);
    expect(ready.restore(node)).toBe(true);
    expect(node.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(node.setSelectionRange).toHaveBeenCalledExactlyOnceWith(3, 7);
    expect(ready.restore(node)).toBe(false);
    loading.remember(node); loading.forget();
    expect(ready.restore(node)).toBe(false);
  });
});
