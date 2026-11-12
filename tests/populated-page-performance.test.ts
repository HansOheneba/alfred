import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { isValidElement, type ReactNode } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ query: vi.fn(), auth: vi.fn(), display: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: (...args: unknown[]) => io.query(...args) }));
vi.mock("@/lib/supabase/session", () => ({ getAuthUser: () => io.auth() }));
vi.mock("@/lib/env", () => ({ getStudioSettings: () => ({
  supabase: { projectRef: "fictional-project", host: "fixture.invalid", user: "fictional", database: "postgres", password: "synthetic-only" },
  ai: { apiKey: "synthetic-only", model: "unused", strongModel: "unused" }, google: null,
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
vi.mock("@/app/chat/chat-panel", () => ({ ChatPanel: (props: unknown) => { io.display("chat", props); return null; } }));
vi.mock("@/app/dashboard/dashboard-client", () => ({ DashboardClient: (props: unknown) => { io.display("dashboard", props); return null; } }));
vi.mock("@/app/accounts/accounts-client", () => ({ AccountsClient: (props: unknown) => { io.display("accounts", props); return null; } }));
vi.mock("@/app/investments/investments-client", () => ({ InvestmentsClient: (props: unknown) => { io.display("investments", props); return null; } }));
vi.mock("@/app/settings/settings-view", () => ({ SettingsView: (props: unknown) => { io.display("settings", props); return null; } }));

import DashboardPage from "@/app/dashboard/page";
import AccountsPage from "@/app/accounts/page";
import InvestmentsPage from "@/app/investments/page";
import { GET as contextGet } from "@/app/api/chat/context/route";
import { GET as settingsGet } from "@/app/api/settings/ledger/route";
import { resetSchemaReadyCache } from "@/lib/supabase/finance-capabilities";
import { browserAccountingState } from "@/lib/finance/accounting/browser-state";
import { resetAccountingDisplayCache } from "@/lib/finance/accounting/display-cache";
import { CPU_OWNER as OWNER } from "./accounting-cpu-fixture";
import { populatedPerformanceFixture } from "./populated-performance-fixture";

const AT = "2026-11-05T10:00:00.000Z";
const fixture = populatedPerformanceFixture();
const profile = { id: OWNER, preferred_name: "Fictional", currency: "GHS", timezone: "Africa/Accra", communication_preference: "concise", financial_goals: "", telegram_user_id: null, chat_id: null, locked_at: null, tone_note: "", telegram_ready: true, conversation_ready: true, reminders_ready: true, morning_enabled: false, commute_enabled: false, evening_enabled: false, morning_minute: 480, commute_minute: 540, evening_minute: 1140 };
const rawRows = fixture.raw.map(row => ({ id: String(row.rowNumber), transaction_id: row.transactionId, created_at: new Date(row.createdAt), transaction_date: row.transactionDate, user_id: OWNER, type: row.type, amount: row.amount, currency: row.currency, category: row.category, description: row.description, payment_method: row.paymentMethod, notes: row.notes, status: row.status, updated_at: new Date(row.updatedAt), source_update_id: row.sourceUpdateId }));
const bankRows = fixture.messages.map(row => ({ id: row.id, owner_id: OWNER, source: row.source, channel: row.channel, external_id: row.externalId, direction: row.direction, kind: row.kind, amount: row.amount, fee: row.fee, currency: row.currency, counterparty: row.counterparty, balance: row.balance, occurred_at: new Date(row.occurredAt), status: row.status, transaction_id: row.transactionId, fee_transaction_id: row.feeTransactionId, asked_at: null, raw: row.raw, read_by: row.readBy }));
const stateRows = [{ state: browserAccountingState(fixture.state) }];
const importedRows = fixture.imported.map(movement => ({ movement }));
const scope = new AsyncLocalStorage<string>();
type Event = { source: string; request: string; responseBytes: number; startedAt: number; completedAt: number };
type Result = { route: string; cacheMode: "cold" | "warm-repeat"; syntheticRttMs: number; modeledDataReadyMs: number; localNodeWorkMs: number; localNodeWorkSamples?: { iterations: number; medianMs: number; minMs: number; maxMs: number }; dbQueries: number; dbResponseCompactJsonBytes: number; authRequests: number; peakSqlConcurrency: number; sourceVersionObservations: number; sources: Record<string, number>; clientPayloadBytes: number; clientPayloadSourceTextBytes: number; payloadCounts: Record<string, number>; firstTransactionPage?: { rows: number; total: number }; firstAccountsPage?: { rows: number; totalMovements: number; totalSnapshots: number } };
const report: Result[] = [];
let events: Event[] = [], active = 0, peak = 0, authRequests = 0, rtt = 0, started = 0;
let queue: (() => void)[] = [];
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const responseBytes = new WeakMap<object, number>();
function source(sql: string) {
  if (sql.includes("as source_version") && sql.includes("as revision")) return "accounting-display-stamp";
  if (sql.includes("to_regclass")) return "schema-readiness";
  if (sql.includes("alfred_accounting_source_version")) return "accounting-source-version";
  if (sql.includes(") as token") && sql.includes("as account_names")) return "ledger-bank-metadata";
  if (sql.includes(") as investments") && sql.includes("as contributions")) return "investment-portfolio-inputs";
  return sql.match(/(?:from|join)\s+public\.([a-z_]+)/i)?.[1] ?? "other-select";
}
function fixtureRows(sql: string, values: unknown[]) {
  if (/^\s*(?:insert|update|delete|alter|create|drop)\b/i.test(sql)) throw new Error(`Read path attempted a write: ${source(sql)}`);
  if (sql.includes("as source_version") && sql.includes("as revision")) return [{ revision: String(fixture.state.revision), source_version: "fictional-stable-source-version" }];
  if (sql.includes("to_regclass")) return [{ ready: true, portability_ready: true, receipts_ready: true, provider_summaries_ready: true }];
  if (sql.includes("alfred_accounting_source_version")) return [{ version: "fictional-stable-source-version" }];
  if (sql.includes(") as token") && sql.includes("as account_names")) return [{ token: null, account_names: "", balances: [] }];
  if (sql.includes(") as investments") && sql.includes("as contributions")) return [{ investments: [], holdings: [], values: [], contributions: [] }];
  if (/from public\.profiles p/i.test(sql)) return [profile];
  if (/from public\.accounting_states/i.test(sql)) return stateRows;
  if (/from public\.transactions/i.test(sql)) return rawRows;
  if (/from public\.bank_messages/i.test(sql)) return values[1] === "needs_label" ? [] : bankRows;
  if (/from public\.imported_finance_sources/i.test(sql)) return importedRows;
  return [];
}
async function walk(node: ReactNode): Promise<void> {
  if (Array.isArray(node)) { for (const child of node) await walk(child); return; }
  if (!isValidElement<{ children?: ReactNode }>(node)) return;
  if (typeof node.type === "function") await walk(await (node.type as (props: unknown) => ReactNode | Promise<ReactNode>)(node.props));
  else if (node.props.children) await walk(node.props.children);
}
function payloadFacts(value: unknown) {
  const counts: Record<string, number> = {}; let sourceTextBytes = 0;
  const visit = (item: unknown) => {
    if (Array.isArray(item)) { for (const child of item) visit(child); return; }
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (Array.isArray(child) && ["movements", "snapshots", "rows", "transactions", "activity", "items"].includes(key)) counts[key] = (counts[key] ?? 0) + child.length;
      if (key === "sourceText" && typeof child === "string") sourceTextBytes += Buffer.byteLength(child);
      else visit(child);
    }
  };
  visit(value); return { counts, sourceTextBytes };
}
async function simulate(route: string, rttMs: number, work: () => Promise<unknown>, cacheMode: Result["cacheMode"] = "cold", record = true) {
  vi.useFakeTimers(); vi.setSystemTime(new Date(AT)); resetSchemaReadyCache();
  if (cacheMode === "cold") resetAccountingDisplayCache();
  events = []; queue = []; active = 0; peak = 0; authRequests = 0; rtt = rttMs; started = Date.now(); io.display.mockClear();
  const cpuAt = performance.now(); let value: unknown; let failure: unknown;
  const pending = scope.run(route, work).then(result => { value = result; }, error => { failure = error; });
  await vi.runAllTimersAsync(); await pending;
  const localNodeWorkMs = performance.now() - cpuAt;
  if (failure) throw failure;
  const sources: Record<string, number> = {};
  for (const event of events) sources[event.source] = (sources[event.source] ?? 0) + 1;
  const facts = payloadFacts(value);
  const page = (value as { transactions?: { initialPage?: { rows: unknown[]; total: number } } }).transactions?.initialPage;
  const candidate = (value as { initialView?: { kind?: string; page: { rows: unknown[] }; counts: { movements: number; snapshots: number } } }).initialView;
  const accounts = candidate?.kind === "accounts-read" ? candidate : undefined;
  const result: Result = { route, cacheMode, syntheticRttMs: rttMs, modeledDataReadyMs: Date.now() - started, localNodeWorkMs: Number(localNodeWorkMs.toFixed(3)), dbQueries: events.length, dbResponseCompactJsonBytes: events.reduce((n, event) => n + event.responseBytes, 0), authRequests, peakSqlConcurrency: peak, sourceVersionObservations: sources["accounting-source-version"] ?? 0, sources, clientPayloadBytes: bytes(value), clientPayloadSourceTextBytes: facts.sourceTextBytes, payloadCounts: facts.counts, ...(page ? { firstTransactionPage: { rows: page.rows.length, total: page.total } } : {}), ...(accounts ? { firstAccountsPage: { rows: accounts.page.rows.length, totalMovements: accounts.counts.movements, totalSnapshots: accounts.counts.snapshots } } : {}) };
  expect(active).toBe(0); expect(queue).toHaveLength(0); expect(peak).toBeLessThanOrEqual(3);
  if (record) report.push(result); vi.useRealTimers(); return result;
}
async function runPair(route: string, rttMs: number, read: () => Promise<unknown>) {
  const cold = await simulate(route, rttMs, read), warm = await simulate(route, rttMs, read, "warm-repeat");
  if (rttMs !== 0) return;
  for (const [mode, target] of [["cold", cold], ["warm-repeat", warm]] as const) {
    const samples: number[] = [];
    for (let iteration = 0; iteration < 10; iteration++) { const result = await simulate(route, 0, read, mode, false); if (iteration >= 3) samples.push(result.localNodeWorkMs); }
    samples.sort((a, b) => a - b);
    target.localNodeWorkSamples = { iterations: samples.length, medianMs: samples[Math.floor(samples.length / 2)], minMs: samples[0], maxMs: samples.at(-1)! };
  }
}
beforeAll(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fictional.invalid"); vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "fictional-public-key");
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Fictional benchmark must not access the network"); });
  io.auth.mockImplementation(async () => { authRequests++; await new Promise(resolve => setTimeout(resolve, rtt)); return { id: OWNER, email: "fictional@example.invalid" }; });
  io.query.mockImplementation(async (_settings: unknown, sql: string, values: unknown[] = []) => {
    const name = source(sql); if (values.length && name !== "market_prices") expect(values[0]).toBe(OWNER);
    const rows = fixtureRows(sql, values);
    if (!responseBytes.has(rows)) responseBytes.set(rows, bytes(rows));
    const event: Event = { source: name, request: scope.getStore() ?? "unknown", responseBytes: responseBytes.get(rows)!, startedAt: -1, completedAt: -1 }; events.push(event);
    await new Promise<void>(resolve => {
      const begin = () => { active++; peak = Math.max(peak, active); event.startedAt = Date.now() - started;
        setTimeout(() => { event.completedAt = Date.now() - started; active--; queue.shift()?.(); resolve(); }, rtt);
      }; if (active < 3) begin(); else queue.push(begin);
    });
    return rows;
  });
});
afterAll(async () => {
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  if (process.env.ALFRED_POPULATED_PAGE_OUTPUT) await writeFile(process.env.ALFRED_POPULATED_PAGE_OUTPUT, JSON.stringify({
    description: "Actual server page/API read-loader graph on fictional imported-majority populated state, mocked SQL/auth transport and client display only.",
    fixture: { owner: "fictional UUID", movements: 2315, snapshots: 2277, rawTransactionRows: 2, bankMessageRows: 6, importedMovements: 2309, accounts: 8, transferLinks: 200, auditBeforeCopies: 4, accountRules: 0, investments: 0, goals: 0, budgets: 0 },
    model: "FIFO SQL pool3; synthetic RTT0/100ms per query, auth separate same-RTT wait. Cold accounting display cache per cold scenario; warm-repeat immediately repeats same page/resource with fresh revision/source-version stamp. Cold schema cache per scenario. SQL responses honor existing audit-before projection; database response bytes are compact JSON equivalents. LocalNodeWorkMs includes test scheduling and mock query bookkeeping, not production CPU. Final server-props JSON byte counting is outside that timed section; API Response JSON encoding/decoding is inside it. At zero RTT each cold/warm loader has 3 warmups then 7 measured samples reported separately. Client payload bytes count JSON of props/API JSON before compression, not Next RSC/browser HTTP bytes.",
    limitations: "No live database/auth/session/browser/market API. Does not include database SQL execution, payload transfer bandwidth/JSON decode, DNS/TLS/reconnect, compilation, React rendering/hydration, or latency from a realistic audit/source distribution. A source-version pair is checked for every accounting rebuild; all versions are stable in the fixture. Fixture counts and text lengths are declared choices, not tuned to reproduce reported production MB or seconds.",
    results: report,
  }, null, 2) + "\n");
});
describe("fictional populated page and resource source-read benchmark", () => {
  for (const rttMs of [0, 100]) {
    for (const [route, page, view] of [["/dashboard", DashboardPage, "dashboard"], ["/accounts", AccountsPage, "accounts"], ["/investments", InvestmentsPage, "investments"]] as const) {
      it(`${route} with ${rttMs}ms synthetic RTT`, async () => {
        const read = async () => { await walk(page()); expect(io.display).toHaveBeenCalledWith(view, expect.anything()); const props = io.display.mock.calls.find(call => call[0] === view)![1];
          if (view === "accounts") {
            if (props.initialView) { expect(props.initialView).toMatchObject({ kind: "accounts-read", availability: "ready", counts: { movements: 2315, snapshots: 2277 } }); expect(props.initialView.page.rows).toHaveLength(25); expect(payloadFacts(props).sourceTextBytes).toBe(0); }
            else expect(props).toMatchObject({ initialPayload: { ok: true, availability: "ready" } });
          }
          if (view === "dashboard" && props.transactions) { expect(props.transactions.initialPage.rows).toHaveLength(15); expect(props.transactions.initialPage.total).toBe(1915); expect(props.ledger.rows).toHaveLength(0); expect(props.overview.totalRowCount).toBe(1915); }
          return props;
        };
        await runPair(route, rttMs, read);
      }, 20_000);
    }
    it(`/api/chat/context with ${rttMs}ms synthetic RTT`, async () => {
      const read = async () => { const response = await contextGet(); expect(response.status).toBe(200); const value = await response.json(); expect(value).toMatchObject({ ok: true, ownerId: OWNER }); return value; };
      await runPair("GET /api/chat/context", rttMs, read);
    }, 20_000);
    for (const section of ["budgets", "goals", "bank"] as const) {
      it(`/api/settings/ledger?section=${section} with ${rttMs}ms synthetic RTT`, async () => {
        const read = async () => { const handler = settingsGet as (request?: Request) => Promise<Response>; const response = await handler(new Request(`https://fictional.invalid/api/settings/ledger?section=${section}`)); expect(response.status).toBe(200); const value = await response.json(); expect(value).toMatchObject({ ok: true, ownerId: OWNER }); return value; };
        await runPair(`GET /api/settings/ledger?section=${section}`, rttMs, read);
      }, 20_000);
    }
  }
});
