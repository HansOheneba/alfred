import { describe, expect, it } from "vitest";

import { findInvite, parseInvites } from "@/lib/auth/invites";

describe("invites", () => {
  const list = " Friend@Example.com:546068741 , second@example.com:546068741,plain@example.com ";

  it("reads emails with and without a Telegram ID", () => {
    const invites = parseInvites(list);
    expect([...invites.keys()]).toEqual(["friend@example.com", "second@example.com", "plain@example.com"]);
    expect(invites.get("friend@example.com")?.telegramUserId).toBe(546068741);
    expect(invites.get("plain@example.com")?.telegramUserId).toBeNull();
  });

  it("matches an email whatever its case and spacing", () => {
    expect(findInvite("  FRIEND@example.COM ", list)?.telegramUserId).toBe(546068741);
    expect(findInvite("stranger@example.com", list)).toBeNull();
    expect(findInvite(null, list)).toBeNull();
  });

  it("closes sign-up when the list is empty or missing", () => {
    expect(findInvite("friend@example.com", "")).toBeNull();
    expect(findInvite("friend@example.com", undefined)).toBeNull();
  });

  it("skips malformed entries and ignores a bad Telegram ID", () => {
    const invites = parseInvites("not-an-email:1,ok@example.com:abc,x@example.com:1:2");
    expect([...invites.keys()]).toEqual(["ok@example.com"]);
    expect(invites.get("ok@example.com")?.telegramUserId).toBeNull();
  });
});
