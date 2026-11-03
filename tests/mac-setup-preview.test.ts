import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAC_PROVIDER_SENDERS, MAC_SETUP_STEPS, MacAutomationCard } from "@/app/settings/bank-section";
import { createMacSetupPreviewState, macSetupPreviewReducer, MacSetupPreview, type MacSetupPreviewState } from "@/app/preview/automations/mac-setup-preview";

function reviewedAccount(): MacSetupPreviewState {
  const initial = createMacSetupPreviewState();
  return macSetupPreviewReducer(macSetupPreviewReducer(initial, { type: "review-account", value: true }), { type: "next" });
}
function providerStep(): MacSetupPreviewState {
  return macSetupPreviewReducer(macSetupPreviewReducer(reviewedAccount(), { type: "review-permission", value: true }), { type: "next" });
}
afterEach(() => vi.unstubAllGlobals());

describe("simple Mac setup explanation", () => {
  it("uses three human steps with a separate broad OS permission disclosure", () => {
    expect(MAC_SETUP_STEPS.map((step) => step.title)).toEqual(["Open Alfred Sync", "Allow Messages on this Mac", "Start automatic sync"]);
    const html = renderToStaticMarkup(createElement(MacAutomationCard));
    for (const step of MAC_SETUP_STEPS) expect(html).toContain(step.title);
    expect(html).toContain("Full Disk Access is a broad macOS permission");
    expect(html).toContain("does not narrow that OS permission");
    expect(html).toContain("Your Mac must already receive your iPhone SMS");
    expect(html).toContain("Mac app required");
    expect(html).toContain("opening this page does not install the app or start syncing");
    expect(html).not.toContain("Create forwarding key");
    expect(html).not.toContain("Start capture</button>");
  });
  it("keeps provider, AI, Telegram and compatibility details in an accessible disclosure", () => {
    const html = renderToStaticMarkup(createElement(MacAutomationCard));
    const details = html.slice(html.indexOf("<details"), html.indexOf("</details>") + 10);
    expect(details).toContain("<summary");
    expect(details).toContain("Providers, privacy and setup details");
    expect(details).toContain("DeepSeek");
    expect(details).toContain("separately from the new chat and push choices");
    expect(details).toContain("macOS 27 only");
    expect(details).toContain("Apple silicon");
    expect(details).toContain("not a list of every payment provider");
    expect(details).toContain("no filter can promise");
    expect(html.slice(0, html.indexOf("<details"))).not.toContain("DeepSeek");
  });
});

describe("fictional Mac setup state", () => {
  it("requires reviewing the expected account before moving on", () => {
    const initial = createMacSetupPreviewState();
    expect(macSetupPreviewReducer(initial, { type: "next" })).toMatchObject({ stage: 1, accountReviewed: false });
    expect(reviewedAccount().stage).toBe(2);
  });
  it("blocks a mismatched account and clears stale choices when accounts change", () => {
    let state = providerStep();
    state = macSetupPreviewReducer(state, { type: "provider", id: "absa" });
    state = macSetupPreviewReducer(state, { type: "account", account: "other" });
    expect(state).toMatchObject({ stage: 1, account: "other", accountReviewed: false, permissionReviewed: false, providers: [], newAlertsAcknowledged: false });
    state = macSetupPreviewReducer(state, { type: "review-account", value: true });
    expect(state.accountReviewed).toBe(false);
    expect(macSetupPreviewReducer({ ...state, accountReviewed: true }, { type: "next" }).stage).toBe(1);
    state = macSetupPreviewReducer(state, { type: "account", account: "expected" });
    expect(state.accountReviewed).toBe(false);
  });
  it("requires a mock permission review, with no real OS action", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const state = reviewedAccount();
    expect(macSetupPreviewReducer(state, { type: "next" })).toMatchObject({ stage: 2, permissionReviewed: false });
    expect(providerStep()).toMatchObject({ stage: 3, permissionReviewed: true });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("requires an explicit reviewed provider and new-alert-only acknowledgement", () => {
    let state = providerStep();
    expect(state.providers).toEqual([]);
    expect(macSetupPreviewReducer(state, { type: "next" }).stage).toBe(3);
    state = macSetupPreviewReducer(state, { type: "provider", id: "mobilemoney" });
    expect(macSetupPreviewReducer(state, { type: "next" }).stage).toBe(3);
    state = macSetupPreviewReducer(state, { type: "new-alerts", value: true });
    const finished = macSetupPreviewReducer(state, { type: "next" });
    expect(finished.stage).toBe("complete");
    expect(finished.providers).toEqual(["mobilemoney"]);
    expect(finished).not.toHaveProperty("captureEnabled");
    expect(finished).not.toHaveProperty("credential");
  });
  it("does not offer unsupported providers or accept an injected provider ID", () => {
    expect(MAC_PROVIDER_SENDERS.map((provider) => provider.id)).toEqual(["absa", "mobilemoney", "hubtel", "paysmall", "t-cash", "vf-cash", "t cash", "stanchart"]);
    const state = providerStep();
    expect(macSetupPreviewReducer(state, { type: "provider", id: "gcb" as never }).providers).toEqual([]);
    expect(macSetupPreviewReducer({ ...state, providers: ["gcb" as never], newAlertsAcknowledged: true }, { type: "next" }).stage).toBe(3);
  });
  it("resets only fictional state and makes no account or capture request", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    let state = providerStep();
    for (const provider of MAC_PROVIDER_SENDERS) state = macSetupPreviewReducer(state, { type: "provider", id: provider.id });
    state = macSetupPreviewReducer(state, { type: "new-alerts", value: true });
    state = macSetupPreviewReducer(state, { type: "next" });
    expect(state.stage).toBe("complete");
    expect(macSetupPreviewReducer(state, { type: "reset" })).toEqual(createMacSetupPreviewState());
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("renders a made-up account without a sign-in, key or permission action", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const html = renderToStaticMarkup(createElement(MacSetupPreview));
    expect(html).toContain("Fictional account");
    expect(html).toContain("taylor@example.invalid");
    expect(html).toContain("Show a sample account mismatch");
    expect(html).toContain("Continue sample setup");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('type="email"');
    expect(html).not.toContain("Account connected");
    expect(html).not.toContain("Messages allowed");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
