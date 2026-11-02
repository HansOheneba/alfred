import { describe, expect, it } from "vitest";

import { createSyntheticPortabilityTransport } from "./fixtures/portability/portability-transport";
import { readArchive } from "@/portability/archive.mjs";

describe("saved-data review interface harness", () => {
  it("keeps unsupported domains visible and exactly recoverable while a support check changes nothing", async () => {
    const transport = createSyntheticPortabilityTransport("success");
    const before = await transport.pending();
    const result = await transport.previewActivation(before[0].receiptId);
    expect(result.status).toBe("nothing_new");
    expect(await transport.pending()).toEqual(before);
    const detail = await transport.pendingDetail(before[0].receiptId);
    expect(detail.item.pendingDomains.map((domain) => domain.dataset)).toEqual(expect.arrayContaining(["moneyTracker.native.planning.thirdPartyGroups", "moneyTracker.native.planning.plans", "moneyTracker.native.planning.rules"]));
    const archive = await readArchive(await (await transport.downloadPending(before[0].receiptId)).arrayBuffer());
    expect(archive.datasets).toEqual(detail.datasets);
    expect(archive.manifest.namespace).toBe(detail.item.namespace);
  });

  it("requires a separate confirmation and makes activation retries idempotent without deleting saved data", async () => {
    const transport = createSyntheticPortabilityTransport("pendingReady");
    const before = await transport.pending();
    const detail = await transport.pendingDetail(before[0].receiptId);
    const checked = await transport.previewActivation(before[0].receiptId);
    expect(checked.status).toBe("ready");
    if (checked.status !== "ready") throw new Error("Expected an activation review.");
    expect(checked.preview.activationOf).toBe(before[0].receiptId);
    expect(await transport.pending()).toEqual(before);
    const first = await transport.confirm(checked.preview.id);
    expect(await transport.confirm(checked.preview.id)).toEqual(first);
    expect((await transport.pending())[0].activeCounts.native.about_me).toBe(before[0].activeCounts.native.about_me + 1);
    expect((await transport.previewActivation(before[0].receiptId)).status).toBe("nothing_new");
    expect((await transport.pendingDetail(before[0].receiptId)).datasets).toEqual(detail.datasets);
    await transport.undo(first.id);
    expect(await transport.pending()).toEqual(before);
  });

  it("keeps later edits and activation conflicts from changing the saved source or active counts", async () => {
    const blocked = createSyntheticPortabilityTransport("pendingBlocked");
    const before = await blocked.pending();
    const checked = await blocked.previewActivation(before[0].receiptId);
    expect(checked.status).toBe("blocked");
    expect(checked).not.toHaveProperty("preview");
    expect(await blocked.pending()).toEqual(before);
    const edited = createSyntheticPortabilityTransport("edited");
    const editedBefore = await edited.pending();
    await expect(edited.undo(editedBefore[0].receiptId)).rejects.toThrow("later edits");
    expect(await edited.pending()).toEqual(editedBefore);
  });

  it("leaves an undone import inspectable and downloadable while preventing activation", async () => {
    const transport = createSyntheticPortabilityTransport("success");
    const [before] = await transport.pending();
    const original = await transport.pendingDetail(before.receiptId);
    await transport.undo(before.receiptId);
    const [after] = await transport.pending();
    expect(after).toMatchObject({ undone: true, activationAvailable: false, activeCounts: { accounting: {}, native: {} } });
    expect((await transport.previewActivation(before.receiptId)).status).toBe("blocked");
    expect((await transport.pendingDetail(before.receiptId)).datasets).toEqual(original.datasets);
    expect((await transport.downloadPending(before.receiptId)).size).toBeGreaterThan(0);
  });
});
