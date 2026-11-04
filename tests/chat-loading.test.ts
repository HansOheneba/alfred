import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatPanel } from "@/app/chat/chat-panel";
import ChatPage from "@/app/chat/page";
import { AuthForm } from "@/app/auth-form";
import { GET as contextRoute } from "@/app/api/chat/context/route";
import type { ThreadMessage } from "@/lib/accounts/thread";
import type { Ledger } from "@/lib/web/ledger";
import { buildAccountingView } from "@/lib/finance/accounting/view";
import { emptyAccountingState } from "@/lib/finance/accounting/types";

const mocks = vi.hoisted(() => ({
  owner: vi.fn(),
  loadLedger: vi.fn(),
  signedIn: vi.fn(),
  listRecent: vi.fn(),
  network: vi.fn(),
  connection: vi.fn(),
  financeLooksEmpty: vi.fn(),
  paymentEntry: vi.fn(),
}));
vi.mock("next/server", () => ({ connection: mocks.connection }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), redirect: vi.fn() }));
vi.mock("@/app/signed-in", () => ({ publicAuthConfigured: () => true, signedInAccount: mocks.signedIn, MissingAuthConfig: () => null }));
vi.mock("@/lib/web/api", () => ({
  requireOwner: mocks.owner,
  fail: (text: string, status: number) => Response.json({ ok: false, text }, { status }),
}));
vi.mock("@/lib/web/ledger", () => ({ loadLedger: mocks.loadLedger }));
vi.mock("@/lib/web/finance-empty", () => ({ financeLooksEmpty: mocks.financeLooksEmpty }));
vi.mock("@/lib/accounts/supabase-messages", () => ({ createSupabaseMessageLog: () => ({ listRecent: mocks.listRecent }) }));
vi.mock("@/lib/log", () => ({ logError: vi.fn() }));
vi.mock("@/app/chat/payment-entry", async importOriginal => ({ ...await importOriginal<typeof import("@/app/chat/payment-entry")>(), loadPaymentChatEntry: mocks.paymentEntry }));

const OWNER = "00000000-0000-4000-8000-000000000001";
const profile = { profileId: OWNER, preferredName: "Fictional reviewer", currency: "GHS", timezone: "Africa/Accra" };
const settings = { supabase: { projectRef: "synthetic-only" } };
const owner = { profile, settings, store: {} };
const ledger: Ledger = {
  today: "2026-11-02", currency: "GHS", rows: [], budgets: [], goals: [], insights: [], owed: [], owe: [],
  bank: { connected: false, lastUsedAt: null, lastEmptyAt: null, accountNames: [], needsLabel: [], balances: [] },
  accounting: { availability: "ready", revision: 0, balances: buildAccountingView(emptyAccountingState(OWNER), "GHS").balances, loans: [], issues: [] },
};
const history: ThreadMessage[] = [{ id: "synthetic-assistant", role: "assistant", text: "Your existing conversation is still here.", channel: "web", createdAt: "2026-11-02T12:00:00.000Z", clientId: null }];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.owner.mockResolvedValue(owner);
  mocks.connection.mockResolvedValue(undefined);
  mocks.loadLedger.mockResolvedValue(ledger);
  mocks.financeLooksEmpty.mockResolvedValue(false);
  mocks.signedIn.mockResolvedValue({ kind: "ready", userId: OWNER, profile, settings });
  mocks.listRecent.mockResolvedValue([]);
  mocks.paymentEntry.mockResolvedValue({ state: "unavailable" });
  mocks.network.mockImplementation(() => { throw new Error("Synthetic SSR must not request network data"); });
  vi.stubGlobal("fetch", mocks.network);
});
afterEach(() => {
  expect(mocks.network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("optional Chat finance context", () => {
  it.each([401, 403])("does not read a financial summary when owner authentication returns %s", async (status) => {
    mocks.owner.mockResolvedValue(Response.json({ ok: false, text: "Sign in first." }, { status }));
    const response = await contextRoute();
    expect(response.status).toBe(status);
    expect(mocks.loadLedger).not.toHaveBeenCalled();
  });

  it("loads only the authenticated owner's financial summary without accepting owner arguments", async () => {
    const response = await contextRoute();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ownerId: OWNER, ledger });
    expect(mocks.connection).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.owner).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.loadLedger).toHaveBeenCalledExactlyOnceWith(profile, settings);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("preserves framework request-time bailouts before entering the error handler", async () => {
    const cancellation = new Error("synthetic prerender cancellation");
    mocks.connection.mockRejectedValue(cancellation);
    await expect(contextRoute()).rejects.toBe(cancellation);
    expect(mocks.owner).not.toHaveBeenCalled();
    expect(mocks.loadLedger).not.toHaveBeenCalled();
  });

  it("reports failed finance loading instead of returning a fake empty ledger", async () => {
    mocks.loadLedger.mockRejectedValue(new Error("synthetic database timeout: never show internal details"));
    const response = await contextRoute();
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({ ok: false, text: "Your financial summary could not be loaded. You can keep chatting and try again." });
    expect(body).not.toHaveProperty("ledger");
    expect(JSON.stringify(body)).not.toContain("database timeout");
  });

  it("keeps existing history and the composer usable before finance context has loaded", () => {
    const markup = renderToStaticMarkup(createElement(ChatPanel, { ownerId: OWNER, name: "Fictional reviewer", initialMessages: history }));
    expect(markup).toContain("Your existing conversation is still here.");
    expect(markup).toContain('id="alfred-message"');
    expect(markup).toContain('aria-label="Send"');
    expect(markup).toContain('aria-label="Show context"');
    expect(markup).not.toContain("Start with an expense or income, or");
    expect(markup).not.toContain("GH₵0.00");
    expect(markup).not.toContain("No transactions");
    expect(mocks.loadLedger).not.toHaveBeenCalled();
  });

  it("preserves supplied choice buttons and links alongside the usable composer", () => {
    const markup = renderToStaticMarkup(createElement(ChatPanel, { ownerId: OWNER, name: "Fictional reviewer", initialMessages: history, initialChoices: [[{ label: "Food", choice: "b:fictional:Food" }, { label: "Manage categories", href: "/accounts?tab=needs-attention" }]] }));
    expect(markup).toContain("Answer Alfred&#x27;s question");
    expect(markup).toContain(">Food</button>");
    expect(markup).toContain('href="/accounts?tab=needs-attention"');
    expect(markup).toContain('id="alfred-message"');
    expect(mocks.loadLedger).not.toHaveBeenCalled();
  });

  it("still offers a first conversation without claiming an unknown financial state is empty", () => {
    const markup = renderToStaticMarkup(createElement(ChatPanel, { ownerId: OWNER, name: "Fictional reviewer", initialMessages: [], ledger: null }));
    expect(markup).toContain("A purchase, a payday, a plan. Where shall we start?");
    expect(markup).toContain('id="alfred-message"');
    expect(markup).toContain('aria-label="Show context"');
    expect(markup).not.toContain("GH₵0.00");
    expect(markup).not.toContain("Start with an expense or income, or");
  });

  it("shows Get Started from the server's empty-account check without loading the summary", () => {
    const markup = renderToStaticMarkup(createElement(ChatPanel, { ownerId: OWNER, name: "Fictional reviewer", initialMessages: history, financialsEmpty: true }));
    expect(markup).toContain("Start with an expense or income, or");
    expect(markup).not.toContain('aria-label="Show context"');
    expect(mocks.loadLedger).not.toHaveBeenCalled();
  });
});

describe("Chat server page critical path", () => {
  type Search = { searchParams: Promise<{ question?: string; payment?: string }> };
  type Shell = ReactElement<{ children: ReactElement<{ initialMessages: ThreadMessage[]; initialQuestion: string; ledger?: Ledger | null; financialsEmpty: boolean; loadInitialChoices: boolean; initialPaymentTarget?: string; initialPaymentEntry?: { state: string } }> }>;
  type SuspendedPage = ReactElement<{ children: { type: (props: Search) => Promise<Shell>; props: Search } }>;

  it("awaits conversation history without starting the full finance summary", async () => {
    mocks.loadLedger.mockRejectedValue(new Error("An optional finance request must not block Chat"));
    mocks.listRecent.mockResolvedValue([{ id: "synthetic-history", role: "assistant", body: "History loaded independently.", channel: "web", createdAt: "2026-11-02T12:00:00.000Z", clientId: null }]);
    const page = ChatPage({ searchParams: Promise.resolve({ question: "Review this draft" }) }) as SuspendedPage;
    const shell = await page.props.children.type(page.props.children.props);
    const panel = shell.props.children;
    expect(panel.type).toBe(ChatPanel);
    expect(panel.props.initialMessages).toEqual([expect.objectContaining({ text: "History loaded independently." })]);
    expect(panel.props.initialQuestion).toBe("Review this draft");
    expect(panel.props.ledger == null).toBe(true);
    expect(mocks.listRecent).toHaveBeenCalledExactlyOnceWith(OWNER, 80);
    expect(mocks.loadLedger).not.toHaveBeenCalled();
  });

  it.each([true, false])("passes the same cheap owner-scoped empty status to the first render (%s)", async financialsEmpty => {
    mocks.financeLooksEmpty.mockResolvedValue(financialsEmpty);
    const page = ChatPage({ searchParams: Promise.resolve({}) }) as SuspendedPage;
    const shell = await page.props.children.type(page.props.children.props);
    expect(shell.props.children.props.financialsEmpty).toBe(financialsEmpty);
    expect(mocks.financeLooksEmpty).toHaveBeenCalledExactlyOnceWith(settings.supabase, OWNER);
    expect(mocks.loadLedger).not.toHaveBeenCalled();
  });

  it("defers saved bank answer buttons without blocking the composer or normal conversations", async () => {
    mocks.listRecent.mockResolvedValue([{ id: "fictional-bank-question", role: "assistant", body: "Which category?", intent: "bank:label", channel: "telegram", createdAt: "2026-11-03T12:00:00Z", clientId: null }]);
    const page = ChatPage({ searchParams: Promise.resolve({}) }) as SuspendedPage;
    const shell = await page.props.children.type(page.props.children.props);
    expect(shell.props.children.props.loadInitialChoices).toBe(true);
    expect(mocks.loadLedger).not.toHaveBeenCalled();
    mocks.listRecent.mockResolvedValue([]);
    const empty = ChatPage({ searchParams: Promise.resolve({}) }) as SuspendedPage;
    expect((await empty.props.children.type(empty.props.children.props)).props.children.props.loadInitialChoices).toBe(false);
  });

  it("keeps the conversation usable without claiming empty storage if the initial cheap check fails", async () => {
    mocks.financeLooksEmpty.mockRejectedValue(new Error("Synthetic check unavailable"));
    const page = ChatPage({ searchParams: Promise.resolve({}) }) as SuspendedPage;
    const shell = await page.props.children.type(page.props.children.props);
    expect(shell.props.children.type).toBe(ChatPanel);
    expect(shell.props.children.props.financialsEmpty).toBe(false);
    expect(mocks.loadLedger).not.toHaveBeenCalled();
  });

  it("includes the clicked payment before recent history without a modal or financial summary request", async () => {
    const payment = "11111111-1111-4111-8111-111111111111";
    const target = { id: "source-before-history", clientId: "bank-notice-fictional", role: "assistant", body: "GH₵1.00 moved between your own accounts.", channel: "web", createdAt: "2026-11-01T12:00:00.000Z", paymentNotice: { bankMessageId: payment, requiresPurpose: false } };
    mocks.paymentEntry.mockResolvedValue({ state: "ready", bankMessageId: payment, message: target });
    mocks.listRecent.mockResolvedValue([{ id: "newer", role: "assistant", body: "Later question", channel: "web", createdAt: "2026-11-04T12:00:00.000Z", clientId: null }]);
    const page = ChatPage({ searchParams: Promise.resolve({ payment }) }) as SuspendedPage;
    const shell = await page.props.children.type(page.props.children.props);
    expect(shell.props.children.props.initialPaymentTarget).toBe(payment);
    expect(shell.props.children.props.initialMessages.map(row => row.id)).toEqual([target.id, "newer"]);
    expect(mocks.paymentEntry).toHaveBeenCalledExactlyOnceWith(settings.supabase, OWNER, payment);
    expect(mocks.loadLedger).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(shell.props.children);
    expect(html).toContain("data-payment-selected=\"true\"");
    expect(html).toContain("GH₵1.00 moved between your own accounts.");
    expect(html).not.toContain("Movement details");
  });

  it("keeps history usable when a clicked source is unavailable", async () => {
    const payment = "11111111-1111-4111-8111-111111111111";
    mocks.paymentEntry.mockRejectedValue(new Error("Fictional source query unavailable"));
    mocks.listRecent.mockResolvedValue([{ id: "newer", role: "assistant", body: "Existing conversation", channel: "web", createdAt: "2026-11-04T12:00:00.000Z", clientId: null }]);
    const page = ChatPage({ searchParams: Promise.resolve({ payment }) }) as SuspendedPage;
    const shell = await page.props.children.type(page.props.children.props);
    expect(shell.props.children.type).toBe(ChatPanel);
    expect(shell.props.children.props.initialPaymentEntry).toEqual({ state: "unavailable" });
    expect(renderToStaticMarkup(shell.props.children)).toContain("I couldn&#x27;t open that payment alert.");
  });

  it("preserves only a canonical Chat notification destination through sign-in and reads no private source", async () => {
    mocks.signedIn.mockResolvedValue({ kind: "signed-out" });
    const payment = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const page = ChatPage({ searchParams: Promise.resolve({ payment }) }) as SuspendedPage;
    const auth = await page.props.children.type(page.props.children.props) as unknown as ReactElement<{ returnTo: string }>;
    expect(auth.type).toBe(AuthForm);
    expect(auth.props.returnTo).toBe(`/chat?payment=${payment.toLowerCase()}`);
    expect(mocks.paymentEntry).not.toHaveBeenCalled();
    expect(mocks.listRecent).not.toHaveBeenCalled();
  });
});
