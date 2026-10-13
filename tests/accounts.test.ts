import { describe, expect, it } from "vitest";

import { MemoryAccountDirectory, parseTelegramUserId } from "@/lib/accounts/directory";
import { harness, runUpdate, settings, textUpdate } from "./helpers";

describe("telegram account linking", () => {
  it("locks the saved id after the first private message and rejects a later edit", async () => {
    const accounts = MemoryAccountDirectory.fromIds([42], {
      currency: "GHS",
      timezone: "Africa/Accra",
      communicationPreference: "concise",
    });
    const { deps, telegram } = harness({
      accounts,
      settings: settings({ authorizedUserIds: [42] }),
    });
    await runUpdate(textUpdate(1, 42, "/start"), deps);
    expect(telegram.sent[0]?.text).toContain("Alfred");
    expect(accounts.list()[0]?.lockedAt).toBeTruthy();
    expect(accounts.updateTelegramId("42", 99)).toBe("locked");
    expect(accounts.list()[0]?.telegramUserId).toBe(42);
  });

  it("does not treat a website user id as a Telegram id", async () => {
    const accounts = MemoryAccountDirectory.fromIds([965699706], {
      currency: "GHS",
      timezone: "Africa/Accra",
      communicationPreference: "concise",
    });
    expect(parseTelegramUserId("3f2a1c4e-1111-4111-8111-111111111111")).toBeNull();
    expect(await accounts.resolveTelegram(965699706)).toMatchObject({ profileId: "965699706" });
    expect(accounts.resolveOwner("3f2a1c4e-1111-4111-8111-111111111111")).toBeNull();
    expect(accounts.updateTelegramId("965699706", 568517419)).toBe("updated");
    const other = MemoryAccountDirectory.fromIds([965699706, 568517419], {
      currency: "GHS",
      timezone: "Africa/Accra",
      communicationPreference: "concise",
    });
    expect(other.updateTelegramId("965699706", 568517419)).toBe("taken");
  });
});
