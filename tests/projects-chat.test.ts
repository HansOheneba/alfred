import { describe, expect, it } from "vitest";

import { interpretMessage, type InterpretRequest } from "@/lib/ai/deepseek";
import { claimsWrite } from "@/lib/ai/voice";
import { converse } from "@/lib/conversation/turn";
import type { ActionContext } from "@/lib/finance/action-router";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { decidePending } from "@/lib/finance/pending";
import type { FinanceAction } from "@/lib/finance/schemas";
import { findProject, manageProject } from "@/lib/team/chat";
import { MemoryTeamStore } from "@/lib/team/memory";
import { profile } from "./helpers";

const ME = "00000000-0000-4000-8000-00000000000a", KOJO = "00000000-0000-4000-8000-00000000000b";
async function team() {
  const store = new MemoryTeamStore([{ id: ME, name: "Ama" }, { id: KOJO, name: "Kojo" }]);
  await store.addProject(ME, { title: "Bubble Bliss App Design", summary: "", status: "planned", priority: "high", leadId: KOJO, links: [] });
  await store.addProject(ME, { title: "Recipe planner", summary: "", status: "idea", priority: "medium", leadId: null, links: [] });
  return store;
}

describe("managing the team's projects from chat", () => {
  it("adds an idea with who's taking it and a first note", async () => {
    const store = await team();
    const result = await manageProject({ op: "add", title: "Five-a-side booking", lead: "other", note: "Mobile money first" }, { store, memberId: ME });
    expect(result).toEqual({ text: "Added “Five-a-side booking” as an idea, taken by Kojo, medium priority, with your note." });
    expect(store.projects.find((item) => item.title === "Five-a-side booking")).toMatchObject({ leadId: KOJO, status: "idea", notes: [expect.objectContaining({ body: "Mobile money first", authorId: ME })] });
  });

  it("changes only what was asked, finds the project by part of its name, and adds a link once", async () => {
    const store = await team();
    const access = { store, memberId: ME };
    expect(await manageProject({ op: "update", project: "bubble bliss", status: "building", priority: "medium" }, access)).toEqual({ text: "Updated “Bubble Bliss App Design”: moved to building and set to medium priority." });
    await manageProject({ op: "update", project: "bubble", link: { url: "https://example.com/board", label: "Moodboard" } }, access);
    await manageProject({ op: "update", project: "bubble", link: { url: "https://example.com/board" } }, access);
    expect(store.projects[0]).toMatchObject({ status: "building", priority: "medium", leadId: KOJO, links: [{ url: "https://example.com/board", label: "Moodboard" }] });
    expect(await manageProject({ op: "update", project: "bubble", link: { url: "javascript:alert(1)" } }, access)).toEqual({ text: "“Bubble Bliss App Design” already looks like that. What would you like to change?" });
  });

  it("asks which project when the name is unclear, and lists them by status", async () => {
    const store = await team();
    expect(findProject(store.projects, "Recipe planner")).toHaveLength(1);
    expect((await manageProject({ op: "note", project: "the app", note: "x" }, { store, memberId: ME }) as { text: string }).text).toMatch(/^Which project/);
    const list = (await manageProject({ op: "list" }, { store, memberId: ME }) as { text: string }).text;
    expect(list).toContain("Planned:\n• Bubble Bliss App Design (Kojo, high priority)");
    expect(list).toContain("Ideas:\n• Recipe planner (both of you, medium priority)");
  });

  it("never lets a non-member see or change anything", async () => {
    const store = await team();
    expect(await manageProject({ op: "list" }, { store, memberId: "00000000-0000-4000-8000-0000000000ff" })).toEqual({ text: "I can't help with that here." });
    expect(store.projects).toHaveLength(2);
  });

  it("removes a project only after a yes", async () => {
    const store = await team();
    const ctx: ActionContext = { profile: profile(), store: new MemoryFinanceStore(), now: new Date("2026-11-06T10:00:00Z"), updateId: 5, chatId: 100, confirmTransactions: "auto", pendingTtlMs: 600_000,
      createId: () => "8f02f5de-4444-4444-8444-000000000001", createActionId: () => "remove-1", team: { store, memberId: ME } };
    const interpret = async (): Promise<FinanceAction> => ({ type: "manage_project", op: "remove", project: "recipe" });
    const asked = await converse("delete the recipe planner", ctx, { store: ctx.store, interpret, createId: ctx.createId }, { channel: "web" });
    expect(asked.kind).toBe("confirm");
    expect(store.projects).toHaveLength(2);
    if (asked.kind !== "confirm") return;
    expect((await decidePending({ decision: "confirm", actionId: asked.actionId, chatId: "100" }, ctx)).text).toBe("Removed “Recipe planner” and its notes.");
    expect(store.projects.map((item) => item.title)).toEqual(["Bubble Bliss App Design"]);
  });

  it("doesn't offer projects to someone outside the team", async () => {
    const ctx: ActionContext = { profile: profile(), store: new MemoryFinanceStore(), now: new Date("2026-11-06T10:00:00Z"), updateId: 6, chatId: 100, confirmTransactions: "auto", pendingTtlMs: 600_000,
      createId: () => "8f02f5de-4444-4444-8444-000000000002", createActionId: () => "a" };
    const requests: InterpretRequest[] = [];
    const interpret = async (request: InterpretRequest): Promise<FinanceAction> => { requests.push(request); return { type: "manage_project", op: "list" }; };
    const reply = await converse("what projects do we have", ctx, { store: ctx.store, interpret, createId: ctx.createId }, { channel: "web" });
    expect(requests[0].team ?? null).toBeNull();
    expect(reply.text).toBe("I can't help with that here.");
  });
});

describe("replies that claim a change", () => {
  it("catches chat saying it saved or changed something, however it's worded", () => {
    for (const text of ["Added that link to Bubble Bliss.", "Done. Moved it to building.", "I've updated the project.", "The link has been added."]) expect(claimsWrite(text), text).toBe(true);
    for (const text of ["Want me to add that link?", "You added a note earlier.", "Which project do you mean?"]) expect(claimsWrite(text), text).toBe(false);
  });

  it("retries a request on its own when the conversation makes the model come back empty", async () => {
    const calls: number[] = [];
    const complete = async (_settings: unknown, messages: unknown[]) => {
      calls.push(messages.length);
      if (messages.length > 2) throw Object.assign(new Error("DeepSeek returned empty JSON."), { name: "AiError", code: "invalid" });
      return '{"type":"manage_project","op":"list"}';
    };
    const { AiError } = await import("@/lib/errors");
    const throwing = async (settings: unknown, messages: unknown[]) => { try { return await complete(settings, messages); } catch (error) { throw new AiError("invalid", (error as Error).message); } };
    const action = await interpretMessage({ apiKey: "test", model: "deepseek-flash", baseUrl: "https://example.invalid" } as never,
      { text: "list them", now: new Date(), recent: [], timezone: "Africa/Accra", currency: "GHS", history: [{ role: "user", body: "hi" }, { role: "assistant", body: "Hello" }] } as InterpretRequest, fetch, throwing as never);
    expect(action).toEqual({ type: "manage_project", op: "list" });
    expect(calls.at(-1)).toBe(2);
  });
});
