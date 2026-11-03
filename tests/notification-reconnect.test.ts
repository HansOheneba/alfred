import { describe, expect, it, vi } from "vitest";
import { connectNotificationDevice, type NotificationConnectionActions } from "@/app/settings/notifications-section";

const publicKey = "A".repeat(87), deviceId = "00000000-0000-4000-8000-000000000002";
const privateFixture = "FICTIONAL_PRIVATE_ENDPOINT_OR_KEY";
function connection(key: ArrayBuffer | null | "missing", options: { failSave?: boolean; cleanup?: boolean } = {}) {
  const oldUnsubscribe = vi.fn(async () => false), newUnsubscribe = vi.fn(async () => options.cleanup ?? true);
  const old = { toJSON: () => ({ endpoint: `https://example.invalid/${privateFixture}` }), unsubscribe: oldUnsubscribe,
    ...(key === "missing" ? {} : { options: { applicationServerKey: key } }) };
  const created = { toJSON: () => ({ endpoint: "https://example.invalid/new-fictional-device" }), unsubscribe: newUnsubscribe };
  const subscribe = vi.fn(async () => created), save = vi.fn(async () => {
    if (options.failSave) throw new Error(privateFixture);
    return { deviceId };
  });
  const actions: NotificationConnectionActions = { requestPermission: vi.fn(async (): Promise<NotificationPermission> => "granted"),
    register: vi.fn(async () => ({ pushManager: { getSubscription: async () => old, subscribe } })), save };
  return { actions, old, created, oldUnsubscribe, newUnsubscribe, subscribe, save };
}

describe("explicit safe browser reconnection", () => {
  it("reuses a verified matching-key subscription without replacing it", async () => {
    const test = connection(new Uint8Array(65).buffer);
    expect(await connectNotificationDevice(publicKey, test.actions)).toBe(deviceId);
    expect(test.save).toHaveBeenCalledExactlyOnceWith(test.old.toJSON());
    expect(test.subscribe).not.toHaveBeenCalled(); expect(test.oldUnsubscribe).not.toHaveBeenCalled();
  });
  it.each([new Uint8Array(65).fill(1).buffer, new Uint8Array(64).buffer, null, "missing"] as const)("preserves an old or unverifiable connection until an explicit disconnect", async (key) => {
    const test = connection(key);
    const result = connectNotificationDevice(publicKey, test.actions);
    await expect(result).rejects.toThrow("Turn off its existing notification connection first");
    await expect(result).rejects.not.toThrow(privateFixture);
    expect(test.oldUnsubscribe).not.toHaveBeenCalled(); expect(test.subscribe).not.toHaveBeenCalled(); expect(test.save).not.toHaveBeenCalled();
  });
  it("does not unsubscribe an existing device when owner-bound server linking fails", async () => {
    const test = connection(new Uint8Array(65).buffer, { failSave: true });
    const result = connectNotificationDevice(publicKey, test.actions);
    await expect(result).rejects.toThrow("could not be confirmed"); await expect(result).rejects.not.toThrow(privateFixture);
    expect(test.save).toHaveBeenCalledOnce(); expect(test.oldUnsubscribe).not.toHaveBeenCalled(); expect(test.subscribe).not.toHaveBeenCalled();
  });
  it("fails without a success claim if cleanup of a newly created, unconfirmed device returns false", async () => {
    const test = connection(new Uint8Array(65).buffer, { failSave: true, cleanup: false });
    test.actions.register = async () => ({ pushManager: { getSubscription: async () => null, subscribe: test.subscribe } });
    await expect(connectNotificationDevice(publicKey, test.actions)).rejects.toThrow("Reload to check it");
    expect(test.newUnsubscribe).toHaveBeenCalledOnce(); expect(test.oldUnsubscribe).not.toHaveBeenCalled(); expect(test.subscribe).toHaveBeenCalledOnce();
  });
  it("does nothing beyond permission when that explicit browser request is refused", async () => {
    const test = connection(new Uint8Array(65).fill(1).buffer);
    test.actions.requestPermission = async () => "denied";
    await expect(connectNotificationDevice(publicKey, test.actions)).rejects.toThrow("blocked");
    expect(test.actions.register).not.toHaveBeenCalled(); expect(test.oldUnsubscribe).not.toHaveBeenCalled(); expect(test.save).not.toHaveBeenCalled();
  });
  it("does not reflect a failed browser key inspection or change the existing connection", async () => {
    const test = connection(new Uint8Array(65).buffer);
    Object.defineProperty(test.old, "options", { get: () => { throw new Error(privateFixture); } });
    const result = connectNotificationDevice(publicKey, test.actions);
    await expect(result).rejects.toThrow("could not finish"); await expect(result).rejects.not.toThrow(privateFixture);
    expect(test.oldUnsubscribe).not.toHaveBeenCalled(); expect(test.save).not.toHaveBeenCalled();
  });
});
