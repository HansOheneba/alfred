import { describe, expect, it } from "vitest";

import type { InterpretRequest } from "@/lib/ai/model";
import { ALFRED_SUPABASE_HOST, ALFRED_SUPABASE_PROJECT_REF, ALFRED_SUPABASE_USER, type StudioSettings } from "@/lib/config";
import { evalCaseSchema, loadCases } from "@/lib/evals/cases";
import { isDeadEnd, runCase, summarize } from "@/lib/evals/run";
import type { InterpretedAction } from "@/lib/finance/schemas";

const SETTINGS: StudioSettings = {
  ai: { apiKey: "synthetic-only", model: "unused", strongModel: "unused" }, google: null,
  supabase: { projectRef: ALFRED_SUPABASE_PROJECT_REF, host: ALFRED_SUPABASE_HOST, user: ALFRED_SUPABASE_USER, database: "postgres", password: "synthetic-only" },
  authorizedUserIds: [42], timezone: "Africa/Accra", currency: "GHS", confirmTransactions: "auto",
} as StudioSettings;

/** A stand-in model that answers from a script, so the harness itself can be tested without an API key. */
function scripted(answers: ((request: InterpretRequest) => InterpretedAction)[]) {
  let turn = 0;
  return { interpret: async (request: InterpretRequest) => answers[Math.min(turn++, answers.length - 1)](request), voice: null };
}

describe("eval cases", () => {
  it("are all valid, with ids matching file names and known payment refs", async () => {
    const cases = await loadCases();
    expect(cases.length).toBeGreaterThanOrEqual(10);
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
  });

  it("include the real failures that started this", async () => {
    const ids = (await loadCases()).map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining(["george-card-loan", "rent-from-investment", "yes-to-plain-question"]));
  });
});

describe("eval runner", () => {
  const george = async () => (await loadCases()).find((item) => item.id === "george-card-loan")!;

  it("passes when the right things are saved", async () => {
    const brain = scripted([
      (request) => ({ type: "label_payments", answers: [{ items: [request.waiting!.current], action: "own_transfer" }] }),
      (request) => ({ type: "label_payments", answers: [
        { items: [request.waiting!.current], action: "own_transfer" },
        { items: [request.waiting!.lines.findIndex((line) => line.includes("332.19")) + 1], action: "lent", person: "George" },
      ] }),
    ]);
    const result = await runCase(await george(), SETTINGS, brain);
    expect(result.problems).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("fails with a reason when the model's answer leads nowhere", async () => {
    const brain = scripted([() => ({ type: "chat", message: "Sorry, I couldn't tell which waiting payments you meant.", topic: "money" })]);
    const result = await runCase(await george(), SETTINGS, brain);
    expect(result.passed).toBe(false);
    expect(result.problems.join("\n")).toMatch(/payment topUp is needs_label, expected transfer/);
    expect(result.problems.join("\n")).toMatch(/no loan with George/);
  });

  it("checks that a step saved nothing", async () => {
    const evalCase = evalCaseSchema.parse({
      id: "fake", title: "fake", source: "test", now: "2026-11-05T10:00:00.000Z",
      steps: [{ say: "I spent 40 on lunch", expect: { savesNothing: true } }],
    });
    const brain = scripted([() => ({ type: "create_transaction", explicit: true, transactions: [{ transaction_type: "expense", amount: "40.00", currency: "GHS", category: "Food", description: "Lunch", date: null }] })]);
    const result = await runCase(evalCase, SETTINGS, brain);
    expect(result.problems).toContain("step 1: saved something when it should have saved nothing");
  });

  it("summarizes pass rate by tag", () => {
    const summary = summarize([
      { id: "a", title: "a", tags: ["loans"], passed: true, problems: [], steps: [], seconds: 1 },
      { id: "b", title: "b", tags: ["loans", "safety"], passed: false, problems: ["x"], steps: [], seconds: 1 },
    ]);
    expect(summary).toMatchObject({ total: 2, passed: 1, passRate: 0.5, byTag: { loans: 0.5, safety: 0 } });
  });
});

describe("dead ends", () => {
  it("flags a refusal that saves nothing and offers no way forward", () => {
    expect(isDeadEnd({ text: "That category doesn't fit. Pick one from the list.", asksToConfirm: false, choices: 0 }, false)).toBe(true);
  });
  it("allows the same words when Alfred offers buttons, a confirmation or a question", () => {
    expect(isDeadEnd({ text: "That category doesn't fit.", asksToConfirm: false, choices: 5 }, false)).toBe(false);
    expect(isDeadEnd({ text: "I couldn't match that. Save this instead?", asksToConfirm: true, choices: 0 }, false)).toBe(false);
    expect(isDeadEnd({ text: "I couldn't tell which one. Was it the 350?", asksToConfirm: false, choices: 0 }, false)).toBe(false);
  });
  it("allows ordinary answers", () => {
    expect(isDeadEnd({ text: "You owe Kwame GH₵200.00.", asksToConfirm: false, choices: 0 }, false)).toBe(false);
  });
});
