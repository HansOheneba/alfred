import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Select } from "@/app/components/select";
import { CategoryCombobox } from "@/app/components/category-combobox";
import { Button, Card, Field } from "@/app/components/ui";
import { SettingsView } from "@/app/settings/settings-view";
import { BudgetsSection } from "@/app/settings/money-sections";
import { AccountRulesSection } from "@/app/settings/account-rules-section";
import type { AccountSettings } from "@/lib/accounts/settings-store";
import type { Ledger } from "@/lib/web/ledger";
import { createSyntheticAccountRulesTransport } from "./fixtures/portability/account-rules";

const runtime = vi.hoisted(() => ({ active: false, cursor: 0, values: [] as unknown[] }));
vi.mock("react", async load => {
  const react = await load<typeof import("react")>();
  return { ...react,
    useState: <T>(initial: T | (() => T)) => {
      if (!runtime.active) return react.useState(initial);
      const index = runtime.cursor++;
      if (!(index in runtime.values)) runtime.values[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [runtime.values[index], (next: T | ((old: T) => T)) => { runtime.values[index] = typeof next === "function" ? (next as (old: T) => T)(runtime.values[index] as T) : next; }];
    },
    useEffect: (...args: Parameters<typeof react.useEffect>) => { if (!runtime.active) react.useEffect(...args); },
  };
});
vi.mock("@/app/components/category-catalog", () => ({ useCustomCategories: () => [] }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/settings/lazy-settings-data", () => ({ useOwnedSettingsData: () => ({ value: undefined, refreshing: false, retry: vi.fn() }) }));

type Element = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Element[] { return Array.isArray(node) ? node.flatMap(nodes) : isValidElement<Record<string, unknown>>(node) ? [node, ...nodes(node.props.children as ReactNode)] : []; }
function render(component: () => ReactNode) { runtime.active = true; runtime.cursor = 0; try { return component(); } finally { runtime.active = false; } }
function control(tree: ReactNode, label: string) { return nodes(nodes(tree).find(node => node.type === Field && node.props.label === label)?.props.children as ReactNode).find(node => node.type === Select)!; }
function choose(select: Element, value: string) { (select.props.onChange as (event: unknown) => void)({ target: { value } }); }
const initial: AccountSettings = { preferredName: "Fictional", currency: "XYZ", timezone: "Pacific/Apia", communicationPreference: "concise", financialGoals: "", telegramUserId: "", telegramLocked: false, morningEnabled: false, commuteEnabled: false, eveningEnabled: false, morningTime: "08:00", commuteTime: "09:00", eveningTime: "19:00" };
const ledger: Ledger = { today: "2026-11-04", currency: "GHS", rows: [], budgets: [], goals: [], insights: [], owed: [], owe: [], bank: { connected: false, lastUsedAt: null, lastEmptyAt: null, accountNames: [], needsLabel: [], balances: [] } };
afterEach(() => { runtime.active = false; runtime.values = []; runtime.cursor = 0; });

describe("Settings shared dropdown adoption", () => {
  it("keeps unknown saved currency/timezone choices and updates the same profile draft", () => {
    const view = () => SettingsView({ initial, home: "chat" });
    let tree = render(view);
    expect(nodes(tree).some(node => node.type === "select")).toBe(false);
    expect(control(tree, "Currency").props.value).toBe("XYZ");
    expect(nodes(control(tree, "Currency")).some(node => node.type === "option" && node.props.value === "XYZ")).toBe(true);
    expect(control(tree, "Timezone").props.value).toBe("Pacific/Apia");
    choose(control(tree, "Currency"), "GHS"); tree = render(view);
    choose(control(tree, "Timezone"), "Africa/Accra"); tree = render(view);
    expect(control(tree, "Currency").props.value).toBe("GHS");
    expect(control(tree, "Timezone").props.value).toBe("Africa/Accra");
  });

  it("uses the shared category dropdown inside the budget review flow", () => {
    const view = () => BudgetsSection({ ledger });
    let tree = render(view);
    const add = (tree as ReactElement<Record<string, unknown>>).props.action as Element;
    expect(add.type).toBe(Button); expect(String(add.props.className ?? "")).not.toContain("alfred-button--mobileFull"); (add.props.onClick as () => void)(); tree = render(view);
    expect(nodes(tree).some(node => node.type === "select")).toBe(false);
    choose(control(tree, "Category"), "Transport"); tree = render(view);
    expect(control(tree, "Category").props.value).toBe("Transport");
    expect(control(tree, "Category").props.disabled).toBe(false);
    expect(nodes(tree).some(node => node.type === Card)).toBe(true);
    const footerButtons = nodes(tree).filter(node => node.type === Button && ["Cancel", "Review"].includes(String(node.props.children).trim()));
    expect(footerButtons).toHaveLength(2);
    expect(footerButtons.every(node => String(node.props.className).includes("alfred-button--mobileFull"))).toBe(true);
  });

  it("keeps unavailable rule controls disabled and preserves the account/direction fields", () => {
    const tree = render(() => AccountRulesSection({ transport: createSyntheticAccountRulesTransport() }));
    const selects = nodes(tree).filter(node => node.type === Select);
    expect(selects).toHaveLength(3);
    expect(selects.every(node => node.props.disabled === true)).toBe(true);
    expect(control(tree, "Account").props.required).toBe(true);
    expect(control(tree, "Direction").props.value).toBe("out");
  });

  it("uses stable account IDs and direction values when creating an available rule", async () => {
    const transport = createSyntheticAccountRulesTransport();
    runtime.values[0] = await transport.load();
    const view = () => AccountRulesSection({ transport });
    let tree = render(view);
    choose(control(tree, "Account"), "synthetic-work-bank"); tree = render(view);
    choose(control(tree, "Direction"), "in"); tree = render(view);
    expect(control(tree, "Account").props.value).toBe("synthetic-work-bank");
    expect(control(tree, "Direction").props.value).toBe("in");
    expect(control(tree, "Account").props.disabled).toBe(false);
    expect(nodes(control(tree, "Account")).filter(node => node.type === "option").map(node => node.props.value)).toEqual(["", "synthetic-personal-wallet", "synthetic-work-bank"]);
    const category = nodes(tree).find(node => node.type === CategoryCombobox)!;
    expect(category.props["aria-label"]).toBe("Category");
    (category.props.onValueChange as (value: string) => void)("My custom category"); tree = render(view);
    expect(nodes(tree).find(node => node.type === CategoryCombobox)?.props.value).toBe("My custom category");
    expect(control(tree, "Account").props.value).toBe("synthetic-work-bank");
    expect(control(tree, "Direction").props.value).toBe("in");
    expect(nodes(tree).some(node => node.type === "datalist")).toBe(false);
  });
});
