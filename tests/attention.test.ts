import { describe, expect, it } from "vitest";

import { nothingWaiting } from "@/lib/conversation/turn";
import { attentionLine } from "@/lib/finance/context";
import { attentionSummary } from "@/lib/finance/accounting/types";

describe("what needs attention", () => {
  it("counts the same movements the Accounts page lists", () => {
    expect(
      attentionSummary([
        { accountId: null, status: "confirmed" },
        { accountId: "a", status: "review" },
        { accountId: null, status: "review" },
        { accountId: "a", status: "hold" },
        { accountId: "a", status: "confirmed" },
      ]),
    ).toEqual({ total: 4, review: 2, unassigned: 2, hold: 1 });
  });

  it("says so plainly when nothing does", () => {
    expect(attentionLine({ total: 0, review: 0, unassigned: 0, hold: 0 })).toBe("Nothing on the Accounts page needs attention.");
    expect(nothingWaiting({ total: 0, review: 0, unassigned: 0, hold: 0 })).toMatch(/^Nothing is waiting for a label/);
    expect(nothingWaiting(null)).toMatch(/^Nothing is waiting for a label/);
  });

  it("names one movement in the singular", () => {
    expect(attentionLine({ total: 1, review: 1, unassigned: 0, hold: 0 })).toBe("1 movement needs attention on the Accounts page (1 waiting for a category).");
  });
});
