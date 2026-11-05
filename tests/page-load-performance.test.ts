import { AsyncLocalStorage } from "node:async_hooks";
import { writeFile } from "node:fs/promises";
import { isValidElement, type ReactNode } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ query: vi.fn(), auth: vi.fn(), display: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: (...args: unknown[]) => io.query(...args) }));
vi.mock("@/lib/supabase/session", () => ({ getAuthUser: () => io.auth() }));
vi.mock("@/lib/env", () => ({ getStudioSettings: () => ({
  supabase: { projectRef: "fictional-project", host: "fixture.invalid", user: "fictional", database: "postgres", password: "synthetic-only" },
  deepseek: { apiKey: "synthetic-only", model: "unused" }, google: null,
  authorizedUserIds: [], timezone: "Africa/Accra", currency: "GHS", confirmTransactions: "always",
}) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/server", () => ({ connection: async () => undefined, after: () => { throw new Error("Unexpected deferred write"); } }));
vi.mock("next/navigation", () => ({ redirect: (location: string) => { throw Object.assign(new Error("Fixture redirect"), { location }); } }));
vi.mock("@/app/components/app-shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => children, AlfredMark: () => null }));
vi.mock("@/app/chat/chat-shell", () => ({ ChatShell: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/app/chat/chat-draft", () => ({ ChatDraftProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/app/chat/chat-loading", () => ({ ChatLoadingState: () => null }));
vi.mock("@/app/auth-form", () => ({ AuthForm: (props: { mode: string }) => { io.display(`auth:${props.mode}`, props); return null; } }));
vi.mock("@/app/components/page-skeletons", () => ({ DashboardSkeleton: () => null, InvestmentsSkeleton: () => null, SettingsSkeleton: () => null }));
vi.mock("@/app/accounts/accounts-status", () => ({ AccountsLoading: () => null, AccountsErrorState: () => null }));
vi.mock("@/app/chat/chat-panel", async (original) => ({ ...await original<typeof import("@/app/chat/chat-panel")>(), ChatPanel: (props: unknown) => { io.display("chat", props); return null; } }));
vi.mock("@/app/dashboard/dashboard-client", () => ({ DashboardClient: (props: unknown) => { io.display("dashboard", props); return null; } }));
vi.mock("@/app/accounts/accounts-client", () => ({ AccountsClient: (props: unknown) => { io.display("accounts", props); return null; } }));
vi.mock("@/app/investments/investments-client", () => ({ InvestmentsClient: (props: unknown) => { io.display("investments", props); return null; } }));
vi.mock("@/app/settings/settings-view", () => ({ SettingsView: (props: unknown) => { io.display("settings", props); return null; } }));

import ChatPage from "@/app/chat/page";
import DashboardPage from "@/app/dashboard/page";
import AccountsPage from "@/app/accounts/page";
import InvestmentsPage from "@/app/investments/page";
import SettingsPage from "@/app/settings/page";
import PeoplePage from "@/app/people/page";
import NotebookPage from "@/app/notebook/page";
import ReviewPage from "@/app/review/page";
import Home from "@/app/page";
import LoginPage from "@/app/login/page";
import SignupPage from "@/app/signup/page";
import { createOwnedChatThreadRefresh } from "@/app/chat/chat-panel";
import { GET as chatGet } from "@/app/api/chat/route";
import { GET as emptyGet } from "@/app/api/chat/empty/route";
import { resetSchemaReadyCache } from "@/lib/supabase/finance-capabilities";

const OWNER = "11111111-2222-4333-8444-555555555555";
const AT = "2026-11-05T10:00:00.000Z";
type QueryEvent = { request: string; source: string; queuedAt: number; startedAt: number; completedAt: number };
type Result = { route: string; rttMs: number; poolSize: number; shellConstructionMs?: number; dataReadyMs: number; dbQueries: number; authRequests: number; peakSqlConcurrency: number; sources: Record<string, number>; requests: Record<string, { dbQueries: number; lastQueryAt: number }>; redirect?: string; expectedView?: string };
const scope = new AsyncLocalStorage<string>();
const report: Result[] = [];
let events: QueryEvent[] = [], active = 0, peak = 0, authRequests = 0, rtt = 50, started = 0;
let signedIn = true;
let queue: (() => void)[] = [];

function source(sql: string) {
  if (sql.includes("to_regclass")) return "schema-readiness";
  if (sql.includes("alfred_accounting_source_version")) return "accounting-source-version";
  if (sql.includes(" as empty")) return "finance-empty-check";
  if (sql.includes(") as token") && sql.includes("as account_names")) return "ledger-bank-metadata";
  if (sql.includes(") as investments") && sql.includes("as contributions")) return "investment-portfolio-inputs";
  return sql.match(/(?:from|join)\s+public\.([a-z_]+)/i)?.[1] ?? "other-select";
}

function fixtureRows(sql: string) {
  if (/^\s*(?:insert|update|delete|alter|create|drop)\b/i.test(sql)) throw new Error(`Page attempted a write: ${source(sql)}`);
  if (sql.includes("to_regclass")) return [{ ready: true, portability_ready: true, receipts_ready: true, provider_summaries_ready: true }];
  if (sql.includes("alfred_accounting_source_version")) return [{ version: "fictional-stable-source-version" }];
  if (sql.includes(" as empty")) return [{ empty: true }];
  if (sql.includes(") as token") && sql.includes("as account_names")) return [{ token: null, account_names: "", balances: [] }];
  if (sql.includes(") as investments") && sql.includes("as contributions")) return [{ investments: [], holdings: [], values: [], contributions: [] }];
  if (/from public\.profiles p/i.test(sql)) return [{
    id: OWNER, preferred_name: "Fictional", currency: "GHS", timezone: "Africa/Accra", communication_preference: "concise", financial_goals: "",
    telegram_user_id: null, chat_id: null, locked_at: null, tone_note: "", telegram_ready: true, conversation_ready: true, reminders_ready: true,
    morning_enabled: false, commute_enabled: false, evening_enabled: false, morning_minute: 480, commute_minute: 540, evening_minute: 1140,
  }];
  if (/from public\.messages/i.test(sql)) return [{ id: "fictional-assistant", role: "assistant", body: "How can I help?", channel: "web", created_at: new Date(AT), client_id: null, intent: "chat:other", meta: null }];
  // The established fictional owner has ready schemas and empty financial source
  // tables. Actual production loaders still hydrate/project these empty sources.
  return [];
}

async function walk(node: ReactNode): Promise<void> {
  if (Array.isArray(node)) { for (const child of node) await walk(child); return; }
  if (!isValidElement<{ children?: ReactNode }>(node)) return;
  if (typeof node.type === "function") {
    const component = node.type as (props: unknown) => ReactNode | Promise<ReactNode>;
    await walk(await component(node.props));
  } else if (node.props.children) await walk(node.props.children);
}

async function simulate(route: string, rttMs: number, work: () => Promise<{ shellConstructionMs?: number; redirect?: string; expectedView?: string } | void>): Promise<Result> {
  vi.useFakeTimers(); vi.setSystemTime(new Date(AT)); resetSchemaReadyCache();
  events = []; queue = []; active = 0; peak = 0; authRequests = 0; rtt = rttMs; signedIn = true; started = Date.now(); io.display.mockClear();
  let value: Awaited<ReturnType<typeof work>>; let failure: unknown;
  const pending = scope.run(route, work).then(result => { value = result; }, error => { failure = error; });
  await vi.runAllTimersAsync(); await pending;
  if (failure) throw failure;
  const sources: Record<string, number> = {}, requests: Result["requests"] = {};
  for (const event of events) {
    sources[event.source] = (sources[event.source] ?? 0) + 1;
    const request = requests[event.request] ??= { dbQueries: 0, lastQueryAt: 0 };
    request.dbQueries++; request.lastQueryAt = Math.max(request.lastQueryAt, event.completedAt);
  }
  const result: Result = { route, rttMs, poolSize: 3, dataReadyMs: Date.now() - started, dbQueries: events.length, authRequests, peakSqlConcurrency: peak, sources, requests, ...value! };
  expect(active).toBe(0); expect(queue).toHaveLength(0); expect(peak).toBeLessThanOrEqual(3);
  report.push(result); vi.useRealTimers(); return result;
}

beforeAll(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fictional.invalid");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "fictional-public-key");
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Benchmark must never access the network"); });
  io.auth.mockImplementation(async () => { authRequests++; await new Promise(resolve => setTimeout(resolve, rtt)); return signedIn ? { id: OWNER, email: "fictional@example.invalid" } : null; });
  io.query.mockImplementation(async (_settings: unknown, sql: string, values: unknown[] = []) => {
    const name = source(sql);
    // Global market/schema catalogs are the only unowned reads in this fixture.
    if (values.length && name !== "market_prices") expect(values[0]).toBe(OWNER);
    const event = { request: scope.getStore() ?? "unknown", source: name, queuedAt: Date.now() - started, startedAt: -1, completedAt: -1 };
    events.push(event);
    await new Promise<void>(resolve => {
      const begin = () => { active++; peak = Math.max(peak, active); event.startedAt = Date.now() - started;
        setTimeout(() => { event.completedAt = Date.now() - started; active--; queue.shift()?.(); resolve(); }, rtt);
      };
      if (active < 3) begin(); else queue.push(begin);
    });
    return fixtureRows(sql);
  });
});

afterAll(async () => {
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  if (process.env.ALFRED_PAGE_BENCH_OUTPUT) await writeFile(process.env.ALFRED_PAGE_BENCH_OUTPUT, JSON.stringify({
    description: "Actual server page/read-loader graph with fictional ready-schema empty-source owner; mocked SQL/auth transport and client display only.",
    model: "Deterministic simulated RTT per SQL query, FIFO pool size 3; auth is one separate same-RTT wait. Module imports excluded. Shell construction is JSX creation, not browser paint. Chat client effects/browser networking are modeled only by explicit actual GET calls. No production timings or browser/LCP measurement.",
    limitations: "Empty financial source tables do not represent large ledgers, open confirmations, focused payment notices, foreign-exchange/quote misses, DNS/TLS/reconnects, cold server compilation, or client rendering. Each scenario starts cold schema-readiness cache. Redirects include destination server loader but exclude browser redirect/network overhead. /preview and /ui-preview demo routes are excluded from production navigation. Login/signup form display excludes submitting forms and browser hydration.",
    results: report,
  }, null, 2) + "\n");
});

describe("reproducible all-page source-read benchmark", () => {
  for (const rttMs of [50, 100]) {
    for (const [route, page, view] of [
      ["/chat", () => ChatPage({ searchParams: Promise.resolve({}) }), "chat"],
      ["/dashboard", () => DashboardPage(), "dashboard"],
      ["/accounts", () => AccountsPage(), "accounts"],
      ["/investments", () => InvestmentsPage(), "investments"],
      ["/settings", () => SettingsPage(), "settings"],
    ] as const) it(`${route} at ${rttMs}ms synthetic RTT`, async () => {
      await simulate(route, rttMs, async () => {
        const start = Date.now(), shell = page(), shellConstructionMs = Date.now() - start;
        await walk(shell);
        expect(io.display).toHaveBeenCalledWith(view, expect.anything());
        if (view === "accounts") {
          const props = io.display.mock.calls.at(-1)?.[1];
          expect(props).toMatchObject(props.initialView ? { initialView: { kind: "accounts-read", availability: "ready" } } : { initialPayload: { ok: true, availability: "ready" } });
        }
        return { shellConstructionMs, expectedView: view };
      });
    });
    for (const [route, page, target, destination, view] of [
      ["/people", PeoplePage, "/chat", () => ChatPage({ searchParams: Promise.resolve({}) }), "chat"],
      ["/notebook", NotebookPage, "/chat", () => ChatPage({ searchParams: Promise.resolve({}) }), "chat"],
      ["/review", ReviewPage, "/accounts?tab=needs-attention", () => AccountsPage(), "accounts"],
    ] as const) it(`${route} redirect and destination at ${rttMs}ms synthetic RTT`, async () => {
      await simulate(route, rttMs, async () => {
        expect(page).toThrow("Fixture redirect");
        try { page(); } catch (error) { expect(error).toMatchObject({ location: target }); }
        expect(events).toHaveLength(0); expect(authRequests).toBe(0);
        await walk(destination()); expect(io.display).toHaveBeenCalledWith(view, expect.anything());
        return { redirect: target, expectedView: view };
      });
    });
    it(`signed-in / redirects to Chat at ${rttMs}ms synthetic RTT`, async () => {
      await simulate("/ signed-in", rttMs, async () => {
        try { await walk(Home()); throw new Error("Expected a home redirect"); }
        catch (error) { expect(error).toMatchObject({ location: "/chat" }); }
        expect(events).toHaveLength(0);
        await walk(ChatPage({ searchParams: Promise.resolve({}) }));
        expect(io.display).toHaveBeenCalledWith("chat", expect.anything());
        return { redirect: "/chat", expectedView: "chat" };
      });
    });
    it(`signed-out / form at ${rttMs}ms synthetic RTT`, async () => {
      await simulate("/ signed-out", rttMs, async () => {
        signedIn = false; await walk(Home());
        expect(io.display).toHaveBeenCalledWith("auth:sign-in", expect.anything());
        expect(events).toHaveLength(0); return { expectedView: "auth:sign-in" };
      });
    });
    for (const [route, page, view] of [["/login", LoginPage, "auth:sign-in"], ["/signup", SignupPage, "auth:sign-up"]] as const) {
      it(`${route} form shell at ${rttMs}ms synthetic RTT`, async () => {
        await simulate(route, rttMs, async () => {
          await walk(page()); expect(io.display).toHaveBeenCalledWith(view, expect.anything());
          expect(events).toHaveLength(0); expect(authRequests).toBe(0); return { expectedView: view };
        });
      });
    }
    it(`Chat deferred actual GET pipeline at ${rttMs}ms synthetic RTT`, async () => {
      await simulate("/chat deferred GETs", rttMs, async () => {
        let empty: Promise<void> | undefined;
        const request: typeof fetch = async (input) => {
          const url = new URL(String(input), "https://fictional.invalid");
          return scope.run(`GET ${url.searchParams.get("part") ?? "thread"}`, async () => {
            const response = await chatGet(new Request(url)); expect(response.status).toBe(200); return response;
          });
        };
        const refresh = createOwnedChatThreadRefresh(OWNER, () => undefined, request, null, { progressive: true,
          onProgress(progress) {
            if (progress.part === "history" && progress.state === "ready") empty = scope.run("GET empty after history", async () => {
              const response = await emptyGet(); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ ok: true, ownerId: OWNER });
            });
            expect(progress.state).not.toBe("error");
          },
        });
        await refresh.refresh(); expect(empty).toBeDefined(); await empty; refresh.dispose();
      });
    });
  }
});
