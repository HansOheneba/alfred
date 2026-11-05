import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseSettings } from "@/lib/config";

const transport = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/supabase/connection", () => ({ query: transport.query }));
import { createSupabaseTeamStore } from "@/lib/team/store";

const ADA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", KOJO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", OUTSIDER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const idea = { title: "Payday forecast", summary: "What's left before payday", status: "idea" as const, leadId: null };

describe("the team's projects in an ephemeral SQL database", () => {
  let db: PGlite;
  const migration = readFileSync("supabase/migrations/20261105220000_team_projects.sql", "utf8");
  const store = createSupabaseTeamStore({} as SupabaseSettings);
  beforeAll(async () => {
    db = new PGlite();
    await db.exec("create role anon; create role authenticated; create table public.profiles(id uuid primary key, preferred_name text);");
    await db.exec(migration);
    transport.query.mockImplementation(async (_settings: unknown, sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows);
  }, 30_000);
  beforeEach(async () => {
    await db.exec("reset role; truncate profiles cascade");
    await db.query("insert into profiles values ($1, 'Ada'), ($2, 'Kojo'), ($3, 'Someone')", [ADA, KOJO, OUTSIDER]);
    await db.query("insert into team_members (profile_id) values ($1), ($2)", [ADA, KOJO]);
  });
  afterAll(async () => { await db.close(); });

  it("shares projects and notes between members, with names", async () => {
    const project = await store.addProject(ADA, { ...idea, leadId: KOJO });
    expect(project).toMatchObject({ title: "Payday forecast", leadId: KOJO, createdBy: ADA, status: "idea" });
    expect(await store.addNote(KOJO, project!.id, "Learn payday from salary texts first.")).toMatchObject({ authorId: KOJO });
    const seen = await store.board(KOJO);
    expect(seen?.members).toEqual([{ id: ADA, name: "Ada" }, { id: KOJO, name: "Kojo" }]);
    expect(seen?.projects).toEqual([expect.objectContaining({ id: project!.id, notes: [expect.objectContaining({ body: "Learn payday from salary texts first." })] })]);
    expect(await store.updateProject(ADA, project!.id, { status: "building", leadId: null })).toMatchObject({ status: "building", leadId: null, title: "Payday forecast" });
  });

  it("shows and lets a non-member do nothing at all", async () => {
    const project = await store.addProject(ADA, idea);
    expect(await store.isMember(OUTSIDER)).toBe(false);
    expect(await store.board(OUTSIDER)).toBeNull();
    expect(await store.addProject(OUTSIDER, idea)).toBeNull();
    expect(await store.updateProject(OUTSIDER, project!.id, { title: "Taken over" })).toBeNull();
    expect(await store.addNote(OUTSIDER, project!.id, "Hello")).toBeNull();
    expect((await store.board(ADA))?.projects[0]).toMatchObject({ title: "Payday forecast", notes: [] });
  });

  it("only lets a member take a project, and only the author remove a note", async () => {
    expect(await store.addProject(ADA, { ...idea, leadId: OUTSIDER })).toBeNull();
    const project = await store.addProject(ADA, idea);
    expect(await store.updateProject(ADA, project!.id, { leadId: OUTSIDER })).toBeNull();
    const note = await store.addNote(ADA, project!.id, "Mine");
    expect(await store.removeNote(KOJO, note!.id)).toBe(false);
    expect(await store.removeNote(ADA, note!.id)).toBe(true);
  });

  it("gives browsers no direct access, and treats a missing space as nobody being a member", async () => {
    await db.exec("set role authenticated");
    await expect(db.exec("select * from team_projects")).rejects.toThrow(/permission denied/);
    await db.exec("reset role; drop table team_project_notes; drop table team_projects; drop table team_members");
    try {
      expect(await store.isMember(ADA)).toBe(false);
      expect(await store.board(ADA)).toBeNull();
    } finally { await db.exec(migration); }
  });
});
