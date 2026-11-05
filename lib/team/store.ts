import type { z } from "zod";

import type { SupabaseSettings } from "@/lib/config";
import { DatabaseError } from "@/lib/errors";
import { query } from "@/lib/supabase/connection";
import type { newProjectSchema, ProjectNote, ProjectStatus, projectChangeSchema, TeamBoard, TeamProject } from "@/lib/team/types";

export { newProjectSchema, noteSchema, PROJECT_STATUSES, projectChangeSchema } from "@/lib/team/types";
export type { ProjectNote, ProjectStatus, TeamBoard, TeamMember, TeamProject } from "@/lib/team/types";

/**
 * Projects shared between the people who build Alfred: ideas, who's taking
 * each one, and notes on how to build it. The one place in Alfred where rows
 * are shared rather than owned, so every call checks membership first and a
 * non-member sees nothing at all.
 */

export type TeamStore = {
  /** Whether this person may see the team space at all. */
  isMember(profileId: string): Promise<boolean>;
  board(memberId: string): Promise<TeamBoard | null>;
  addProject(memberId: string, project: z.infer<typeof newProjectSchema>): Promise<TeamProject | null>;
  updateProject(memberId: string, id: string, change: z.infer<typeof projectChangeSchema>): Promise<TeamProject | null>;
  addNote(memberId: string, projectId: string, body: string): Promise<ProjectNote | null>;
  removeNote(memberId: string, noteId: string): Promise<boolean>;
};

/** A missing table means the space isn't set up yet: nobody is a member. */
function missingTable(error: unknown): boolean {
  const state = error instanceof DatabaseError ? error.sqlState : (error as { code?: unknown } | null)?.code;
  return state === "42P01";
}

type ProjectRow = { id: string; title: string; summary: string; status: ProjectStatus; lead_id: string | null; created_by: string; created_at: Date; updated_at: Date };
const project = (row: ProjectRow, notes: ProjectNote[] = []): TeamProject => ({
  id: row.id, title: row.title, summary: row.summary, status: row.status, leadId: row.lead_id, createdBy: row.created_by,
  createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), notes,
});
const PROJECT_COLUMNS = "id::text, title, summary, status, lead_id::text, created_by::text, created_at, updated_at";

export function createSupabaseTeamStore(settings: SupabaseSettings): TeamStore {
  const isMember = async (profileId: string) => {
    try {
      return (await query<{ ok: boolean }>(settings, "select exists(select 1 from public.team_members where profile_id=$1::uuid) as ok", [profileId]))[0]?.ok === true;
    } catch (error) {
      if (missingTable(error)) return false;
      throw error;
    }
  };
  return {
    isMember,
    async board(memberId) {
      if (!await isMember(memberId)) return null;
      const [members, projects, notes] = await Promise.all([
        query<{ id: string; name: string | null }>(settings, "select m.profile_id::text as id, p.preferred_name as name from public.team_members m join public.profiles p on p.id=m.profile_id order by m.added_at"),
        query<ProjectRow>(settings, `select ${PROJECT_COLUMNS} from public.team_projects order by updated_at desc`),
        query<{ id: string; project_id: string; author_id: string; body: string; created_at: Date }>(settings, "select id::text, project_id::text, author_id::text, body, created_at from public.team_project_notes order by created_at"),
      ]);
      return {
        members: members.map((row) => ({ id: row.id, name: row.name?.trim() || "Teammate" })),
        projects: projects.map((row) => project(row, notes.filter((note) => note.project_id === row.id).map((note) => ({ id: note.id, authorId: note.author_id, body: note.body, createdAt: note.created_at.toISOString() })))),
      };
    },
    async addProject(memberId, input) {
      // Membership and the lead's membership are checked in the same statement that writes.
      const rows = await query<ProjectRow>(settings, `
        insert into public.team_projects (title, summary, status, lead_id, created_by)
        select $2, $3, $4, $5::uuid, $1::uuid
        where exists (select 1 from public.team_members where profile_id=$1::uuid)
          and ($5::uuid is null or exists (select 1 from public.team_members where profile_id=$5::uuid))
        returning ${PROJECT_COLUMNS}`, [memberId, input.title, input.summary, input.status, input.leadId]);
      return rows[0] ? project(rows[0]) : null;
    },
    async updateProject(memberId, id, change) {
      const rows = await query<ProjectRow>(settings, `
        update public.team_projects set
          title = coalesce($3, title), summary = coalesce($4, summary), status = coalesce($5, status),
          lead_id = case when $6::boolean then $7::uuid else lead_id end, updated_at = now()
        where id=$2::uuid
          and exists (select 1 from public.team_members where profile_id=$1::uuid)
          and ($7::uuid is null or exists (select 1 from public.team_members where profile_id=$7::uuid))
        returning ${PROJECT_COLUMNS}`, [memberId, id, change.title ?? null, change.summary ?? null, change.status ?? null, change.leadId !== undefined, change.leadId ?? null]);
      return rows[0] ? project(rows[0]) : null;
    },
    async addNote(memberId, projectId, body) {
      const rows = await query<{ id: string; author_id: string; body: string; created_at: Date }>(settings, `
        with note as (
          insert into public.team_project_notes (project_id, author_id, body)
          select $2::uuid, $1::uuid, $3
          where exists (select 1 from public.team_members where profile_id=$1::uuid)
            and exists (select 1 from public.team_projects where id=$2::uuid)
          returning id, author_id, body, created_at, project_id
        ), touched as (update public.team_projects set updated_at=now() where id=(select project_id from note))
        select id::text, author_id::text, body, created_at from note`, [memberId, projectId, body]);
      return rows[0] ? { id: rows[0].id, authorId: rows[0].author_id, body: rows[0].body, createdAt: rows[0].created_at.toISOString() } : null;
    },
    async removeNote(memberId, noteId) {
      // A note can only be taken back by whoever wrote it.
      return (await query<{ id: string }>(settings, "delete from public.team_project_notes where id=$2::uuid and author_id=$1::uuid returning id::text", [memberId, noteId])).length > 0;
    },
  };
}
