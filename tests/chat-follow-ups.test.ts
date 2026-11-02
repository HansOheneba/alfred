import { describe, expect, it } from "vitest";

import { followUpsFor } from "@/app/chat/follow-ups";

describe("chat follow-up suggestions", () => {
  it("leads with recording after an ordinary reply", () => {
    const labels = followUpsFor({ chart: null }).map((item) => item.label);
    expect(labels.slice(0, 2)).toEqual(["Add expense", "Add income"]);
    expect(labels).not.toContain("Break it down");
  });

  it("digs into a summary first, with recording still offered", () => {
    const labels = followUpsFor({ chart: { kind: "bar" } as never }).map((item) => item.label);
    expect(labels[0]).toBe("Break it down");
    expect(labels).toEqual(expect.arrayContaining(["Add expense", "Add income"]));
  });

  it("fills the composer for recording instead of sending", () => {
    const expense = followUpsFor(undefined).find((item) => item.label === "Add expense");
    expect(expense).toMatchObject({ text: "Spent ", fill: true });
  });
});
