import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollectorHealthSection, parseCollectorHealth, readCollectorHealth } from "@/app/settings/collector-health-section";

const owner = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const fixture = () => ({ ok: true, ownerId: owner, checkedAt: "2026-11-03T14:30:00Z", devices: [{ deviceId: "33333333-3333-4333-8333-333333333333", state: "needs_review", counts: { sourceQuarantine: 2, unreadable: 1, incomplete: 1, heldForReview: 1, pending: 1 }, lastSeenAt: "2026-11-03T14:29:00Z", lastSuccessfulCaptureAt: "2026-11-03T14:28:00Z", lastAcceptedAt: null }] });
const render = (value = fixture()) => renderToStaticMarkup(createElement(CollectorHealthSection, { preview: true, initial: parseCollectorHealth(value, owner) }));
afterEach(() => vi.unstubAllGlobals());

describe("private visible Mac health", () => {
  it("shows review counts and separates capture from accepted delivery", () => {
    const html = render();
    expect(html).toContain("2 Messages items need a check");
    expect(html).toContain("later readable alerts can continue");
    expect(html).toContain("1 alert is held safely");
    expect(html).toContain("Review saved alerts");
    expect(html).toContain("some records may already exist");
    expect(html).toContain("Last completed Messages check");
    expect(html).toContain("Last alert accepted by Alfred");
    expect(html).toContain("Not reported");
    expect(html).not.toContain("payment received");
  });
  it("never treats an old ready report as proof the Mac is still running", () => {
    const input = fixture(); input.devices[0].lastSeenAt = "2026-11-03T13:00:00Z";
    expect(render(input)).toContain("Check-in overdue");
    expect(render(input)).not.toContain("Check-in received");
  });
  it("keeps pending delivery visible instead of calling it ready", () => {
    const input = fixture(); input.devices[0].state = "needs_review";
    input.devices[0].counts = { sourceQuarantine: 0, unreadable: 0, incomplete: 0, heldForReview: 0, pending: 2 };
    const html = render(input);
    expect(html).toContain("Alerts waiting");
    expect(html).toContain("2 alerts are waiting for Alfred");
    expect(html).not.toContain("Check-in received");
  });
  it("shows no check-in, loading and capture failures honestly", () => {
    expect(render({ ...fixture(), devices: [] })).toContain("No sample Mac has checked in");
    const html = renderToStaticMarkup(createElement(CollectorHealthSection, { ownerId: owner }));
    expect(html).toContain("Checking Mac status");
    expect(html).not.toContain("Check-in received");
    const input = fixture(); input.devices[0].state = "capture_error";
    expect(render(input)).toContain("last Messages check did not complete");
  });
  it("drops accidental private fields and does not render opaque identifiers", () => {
    const input = { ...fixture(), key: "private-fixture", raw: "private-fixture" };
    Object.assign(input.devices[0], { raw: "private-fixture", sender: "private-fixture", rowId: "private-fixture" });
    const safe = parseCollectorHealth(input, owner), html = render(input);
    expect(JSON.stringify(safe)).not.toContain("private-fixture");
    expect(html).not.toContain("private-fixture");
    expect(html).not.toContain(input.devices[0].deviceId);
  });
  it("rejects foreign, malformed, duplicate and future reports", () => {
    expect(() => parseCollectorHealth(fixture(), other)).toThrow("session changed");
    for (const patch of [{ sourceQuarantine: -1 }, { pending: 1.5 }, { heldForReview: "private-fixture" }]) {
      const input = fixture(); Object.assign(input.devices[0].counts, patch);
      expect(() => parseCollectorHealth(input, owner)).toThrow();
    }
    const future = fixture(); future.devices[0].lastSeenAt = "2026-11-04T00:00:00Z";
    expect(() => parseCollectorHealth(future)).toThrow();
    const duplicate = fixture(); duplicate.devices.push(duplicate.devices[0]);
    expect(() => parseCollectorHealth(duplicate)).toThrow();
    const falseReady = fixture(); falseReady.devices[0].state = "ready";
    expect(() => parseCollectorHealth(falseReady)).toThrow();
  });
  it("uses a fresh owner-checked read and does not reflect server errors", async () => {
    const fetcher = vi.fn(async () => Response.json(fixture())); vi.stubGlobal("fetch", fetcher);
    expect((await readCollectorHealth(owner)).ownerId).toBe(owner);
    expect(fetcher).toHaveBeenCalledWith("/api/collector/health", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
    fetcher.mockResolvedValueOnce(Response.json({ text: "private-fixture" }, { status: 503 }));
    await expect(readCollectorHealth(owner)).rejects.toThrow("Mac status could not be checked");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("offers a confirmation for status-only removal with honest limits", () => {
    const html = render();
    expect(html).toContain("Remove saved status");
    expect(html).toContain("does not stop collection");
    expect(html).toContain("revoke the forwarding key");
    expect(html).toContain("delete saved alerts or change financial records");
    expect(html).toContain("active Mac may appear again");
    expect(html).toContain("makes no account request");
    expect(html).not.toContain("held-alert review screen is not available yet");
  });
  it("never displays a previous account's initial health while a new owner loads", () => {
    const html = renderToStaticMarkup(createElement(CollectorHealthSection, { ownerId: other, initial: parseCollectorHealth(fixture(), owner) }));
    expect(html).not.toContain("1 alert is held safely");
    expect(html).not.toContain("Last heard:");
    expect(html).not.toContain(fixture().devices[0].deviceId);
  });
});
