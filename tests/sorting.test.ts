import { describe, expect, it, vi } from "vitest";

import { MemoryMessageLog } from "@/lib/accounts/messages";
import type { InterpretRequest } from "@/lib/ai/deepseek";
import { MemorySorter, groundedOutcome, nextGroup, sortGroups, type SortGroup } from "@/lib/conversation/sorting";
import { converse } from "@/lib/conversation/turn";
import type { ActionContext } from "@/lib/finance/action-router";
import { applyAccountingAction } from "@/lib/finance/accounting/reducer";
import { emptyAccountingState, type AccountingState, type CashMovement } from "@/lib/finance/accounting/types";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import type { FinanceAction } from "@/lib/finance/schemas";
import { profile } from "./helpers";

const OWNER = "42";
const now = new Date("2026-11-05T17:00:00.000Z");

function books(rows: { description: string; count: number; direction?: "in" | "out"; status?: "review" | "hold" | "confirmed"; account?: string | null }[]): AccountingState {
  const state = emptyAccountingState(OWNER);
  state.accounts.push({ id: "acct", label: "Main", provider: "Bank", currency: "GHS", includeInCash: true, createdAt: now.toISOString() });
  rows.forEach((row, index) => {
    for (let copy = 0; copy < row.count; copy++) {
      const movement: CashMovement = {
        id: `import:${index}-${copy}`, ownerId: OWNER, accountId: row.account === undefined ? "acct" : row.account, direction: row.direction ?? "out", status: row.status ?? "review",
        amountMinor: 1000 * (copy + 1), feeMinor: 0, currency: "GHS", date: `2026-0${copy + 1}-10`, occurredAt: null, description: row.description, category: "Uncategorized",
        sourceId: `${index}-${copy}`, sourceKind: "manual", sourceFingerprint: `f-${index}-${copy}`, legacyTransactionId: null, feeTransactionId: null, legacyClassification: null,
      };
      state.movements.push(movement);
    }
  });
  return state;
}

describe("sorting the Needs attention list", () => {
  it("groups by merchant and kind, biggest first, leaving out settled rows and ones with no account", () => {
    const groups = sortGroups(books([
      { description: "APPLE.COM", count: 2, status: "hold" },
      { description: "Wallet withdrawal", count: 4 },
      { description: "APPLE.COM", count: 1 },
      { description: "Done already", count: 3, status: "confirmed" },
      { description: "No account", count: 5, account: null },
    ]));
    expect(groups.map((group) => [group.description, group.count, group.holds])).toEqual([["Wallet withdrawal", 4, false], ["APPLE.COM", 2, true], ["APPLE.COM", 1, false]]);
    expect(groups[0].totalMinor).toBe(10_000);
  });

  it("files a whole group as one change that one undo reverses", async () => {
    const sorter = new MemorySorter(books([{ description: "Wallet withdrawal", count: 4 }, { description: "NETFLIX", count: 1 }]));
    const [group] = await sorter.groups(OWNER);
    expect((await sorter.file(OWNER, group, { status: "confirmed", category: "Transport" }, "request-1")).map((item) => item.description)).toEqual(["NETFLIX"]);
    expect(sorter.state.revision).toBe(1);
    // Read before that change, so filing it again is refused rather than applied to newer books.
    await expect(sorter.file(OWNER, group, { status: "excluded" }, "request-2")).rejects.toThrow(/changed/);
    expect(sorter.state.movements.filter((row) => row.description === "Wallet withdrawal").every((row) => row.status === "confirmed" && row.category === "Transport")).toBe(true);
    expect(await sorter.groups("someone-else")).toEqual([]);
    const undone = applyAccountingAction(sorter.state, { type: "undo", expectedRevision: 1, requestId: "undo-1" });
    expect(undone.movements.filter((row) => row.description === "Wallet withdrawal").every((row) => row.status === "review")).toBe(true);
  });

  it("files straight away only what the person's words say", () => {
    const group = { direction: "out", holds: false } as SortGroup;
    expect(groundedOutcome("those are subscriptions", group, { status: "confirmed", category: "Subscriptions" }, [])).toBe(true);
    expect(groundedOutcome("that's where I shop", group, { status: "confirmed", category: "Food" }, [])).toBe(false);
    expect(groundedOutcome("moving money to my own wallet", group, { status: "excluded" }, [])).toBe(true);
    expect(groundedOutcome("they were cancelled", group, { status: "excluded" }, [])).toBe(true);
    expect(groundedOutcome("no idea", group, { status: "duplicate" }, [])).toBe(false);
  });

  it("moves on in the order the person has been seeing", () => {
    const before = [{ id: "a" }, { id: "b" }, { id: "c" }] as SortGroup[];
    expect(nextGroup(before.filter((group) => group.id !== "b"), "b", before)?.id).toBe("c");
    expect(nextGroup(before, "c")?.id).toBe("a");
    expect(nextGroup([], null)).toBeNull();
  });

  it("asks about a group in chat, files a clear answer, and asks the next", async () => {
    const store = new MemoryFinanceStore();
    const sorter = new MemorySorter(books([{ description: "Wallet withdrawal", count: 3 }, { description: "NETFLIX.COM", count: 2, status: "hold" }]));
    let sequence = 0;
    const ctx: ActionContext = { profile: profile(), store, now, updateId: 9, chatId: 100, confirmTransactions: "auto", pendingTtlMs: 600_000,
      createId: () => `8f02f5de-2222-4222-8222-${String(++sequence).padStart(12, "0")}`, createActionId: () => `action${++sequence}`, sorting: sorter };
    const messages = new MemoryMessageLog();
    const replies: Record<string, FinanceAction> = {
      "let's sort them out here": { type: "ask_next" },
      "my own money moving to my wallet": { type: "file_movements", group: 1, outcome: "own_money" },
      "those are netflix, a subscription": { type: "file_movements", group: 1, outcome: "category", category: "Subscriptions" },
    };
    const interpret = vi.fn(async (request: InterpretRequest) => replies[request.text]);
    async function turn(text: string) {
      const reply = await converse(text, ctx, { store, messages, interpret, createId: ctx.createId }, { channel: "web" });
      await messages.append({ ownerId: OWNER, role: "user", body: text, channel: "web" });
      await messages.append({ ownerId: OWNER, role: "assistant", body: reply.text, channel: "web", intent: reply.intent });
      return reply;
    }
    const first = await turn("let's sort them out here");
    expect(first.text).toContain("“Wallet withdrawal”");
    expect(first.text).not.toMatch(/Accounts page/);
    const second = await turn("my own money moving to my wallet");
    expect(second.text).toContain("Filed those 3 payments as your own money moving");
    expect(second.text).toContain("“NETFLIX.COM”");
    expect(interpret.mock.calls[1][0].open?.join(" ")).toContain("Needs attention list");
    const third = await turn("those are netflix, a subscription");
    expect(third.text).toContain("under Subscriptions");
    expect(sortGroups(sorter.state)).toEqual([]);
  });
});
