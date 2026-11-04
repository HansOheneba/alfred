import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewClient } from "@/app/review/review-client";
import type { ReviewItem } from "@/lib/web/review";

const runtime = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0, send: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: runtime.refresh }) }));
vi.mock("@/app/components/ui", async load => ({
  ...await load<typeof import("@/app/components/ui")>(), sendJson: runtime.send,
}));
vi.mock("react", async load => ({
  ...await load<typeof import("react")>(),
  useMemo: <T>(read: () => T) => read(),
  useState: <T>(initial: T | (() => T)) => {
    const index = runtime.cursor++;
    if (!(index in runtime.states)) runtime.states[index] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [runtime.states[index] as T, (next: T | ((value: T) => T)) => {
      runtime.states[index] = typeof next === "function" ? (next as (value: T) => T)(runtime.states[index] as T) : next;
    }];
  },
}));

type Element = ReactElement<Record<string, unknown>>;
function descendants(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(descendants);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...descendants(node.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return isValidElement<Record<string, unknown>>(node) ? text(node.props.children as ReactNode) : "";
}
function item(direction: ReviewItem["direction"], payee: ReviewItem["payee"] = "person"): ReviewItem {
  return { id: "00000000-0000-4000-8000-000000000001", direction, payee, amount: "1.00", currency: "GHS", occurredAt: "2026-11-04T12:00:00Z", who: "Fictional recipient", payeeKey: "fictional", purpose: "", owed: null, owe: null };
}
function view(items: ReviewItem[]) {
  runtime.cursor = 0;
  return descendants(ReviewClient({ items, timeZone: "Africa/Accra" }));
}
function select(items: ReviewItem[]) {
  const checkbox = view(items).find(node => node.type === "input" && node.props.type === "checkbox");
  expect(checkbox).toBeDefined();
  (checkbox!.props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
  return view(items);
}
beforeEach(() => {
  runtime.states = []; runtime.cursor = 0; vi.clearAllMocks();
  runtime.send.mockResolvedValue({ text: "Sorted 1 payment.", sorted: 1 });
});

describe("supported payment review choices", () => {
  it.each([
    ["out", "person"], ["in", "person"], ["out", "card"],
  ] as const)("does not offer a rejected Skip or pretend a %s %s alert is a confirmed card settlement", (direction, payee) => {
    const buttons = select([item(direction, payee)]).filter(node => node.type === "button").map(node => text(node));
    expect(buttons).not.toContain("Skip");
    expect(buttons).not.toContain("Yes, same payment");
    expect(buttons).toContain(direction === "out" ? "Food" : "Salary");
    expect(buttons).toContain("For someone else");
    expect(buttons).toContain("My own money");
    expect(runtime.send).not.toHaveBeenCalled();
  });

  it("keeps a selected category explicit and submits only the chosen alert", async () => {
    const chosen = item("out"), nodes = select([chosen]);
    const category = nodes.find(node => node.type === "button" && text(node) === "Food");
    (category!.props.onClick as () => void)();
    await Promise.resolve();
    expect(runtime.send).toHaveBeenCalledExactlyOnceWith("/api/bank/review", "POST", {
      action: "category", messageIds: [chosen.id], remember: true, category: "Food",
    });
    expect(runtime.refresh).toHaveBeenCalledOnce();
    expect(view([chosen]).some(node => node.type === "button" && text(node) === "Food")).toBe(false);
  });
});
