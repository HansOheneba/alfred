import type { z } from "zod";

import type { SupabaseSettings } from "@/lib/config";
import { DatabaseError } from "@/lib/errors";
import { query } from "@/lib/supabase/connection";
import type { newProjectSchema, ProjectLink, ProjectNote, ProjectPriority, ProjectStatus, projectChangeSchema, TeamBoard, TeamProject } from "@/lib/team/types";

export { newProjectSchema, noteSchema, PROJECT_PRIORITIES, PROJECT_STATUSES, projectChangeSchema } from "@/lib/team/types";
export type { ProjectLink, ProjectNote, ProjectPriority, ProjectStatus, TeamBoard, TeamMember, TeamProject } from "@/lib/team/types";

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
  removeProject(memberId: string, id: string): Promise<boolean>;
  addNote(memberId: string, projectId: string, body: string): Promise<ProjectNote | null>;
  editNote(memberId: string, noteId: string, body: string): Promise<ProjectNote | null>;
  removeNote(memberId: string, noteId: string): Promise<boolean>;
};

/** A missing table means the space isn't set up yet: nobody is a member. */
function missingTable(error: unknown): boolean {
  const state = error instanceof DatabaseError ? error.sqlState : (error as { code?: unknown } | null)?.code;
  return state === "42P01";
}

type ProjectRow = {
  id: string; title: string; summary: string; status: ProjectStatus; priority: ProjectPriority; lead_id: string | null; links: unknown;
  created_by: string; created_at: Date; updated_at: Date; shipped_at: Date | null;
};
type NoteRow = { id: string; author_id: string; body: string; created_at: Date; edited_at: Date | null };

/** Stored links are checked on the way in; anything malformed on the way out is dropped rather than shown. */
function readLinks(value: unknown): ProjectLink[] {
  const list = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => item && typeof item === "object" && typeof (item as ProjectLink).url === "string"
    ? [{ url: (item as ProjectLink).url, label: typeof (item as ProjectLink).label === "string" ? (item as ProjectLink).label : "" }]
    : []);
}
const project = (row: ProjectRow, notes: ProjectNote[] = []): TeamProject => ({
  id: row.id, title: row.title, summary: row.summary, status: row.status, priority: row.priority, leadId: row.lead_id, links: readLinks(row.links),
  createdBy: row.created_by, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), shippedAt: row.shipped_at?.toISOString() ?? null, notes,
});
const note = (row: NoteRow): ProjectNote => ({ id: row.id, authorId: row.author_id, body: row.body, createdAt: row.created_at.toISOString(), editedAt: row.edited_at?.toISOString() ?? null });
const PROJECT_COLUMNS = "id::text, title, summary, status, priority, lead_id::text, links, created_by::text, created_at, updated_at, shipped_at";
const NOTE_COLUMNS = "id::text, author_id::text, body, created_at, edited_at";
const MEMBER = "exists (select 1 from public.team_members where profile_id=$1::uuid)";

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
        query<NoteRow & { project_id: string }>(settings, `select ${NOTE_COLUMNS}, project_id::text from public.team_project_notes order by created_at`),
      ]);
      return {
        members: members.map((row) => ({ id: row.id, name: row.name?.trim() || "Teammate" })),
        projects: projects.map((row) => project(row, notes.filter((item) => item.project_id === row.id).map(note))),
      };
    },
    async addProject(memberId, input) {
      // Membership and the lead's membership are checked in the same statement that writes.
      const rows = await query<ProjectRow>(settings, `
        insert into public.team_projects (title, summary, status, priority, lead_id, links, created_by, shipped_at)
        select $2, $3, $4, $5, $6::uuid, $7::jsonb, $1::uuid, case when $4='shipped' then now() end
        where ${MEMBER}
          and ($6::uuid is null or exists (select 1 from public.team_members where profile_id=$6::uuid))
        returning ${PROJECT_COLUMNS}`, [memberId, input.title, input.summary, input.status, input.priority, input.leadId, JSON.stringify(input.links)]);
      return rows[0] ? project(rows[0]) : null;
    },
    async updateProject(memberId, id, change) {
      const rows = await query<ProjectRow>(settings, `
        update public.team_projects set
          title = coalesce($3, title), summary = coalesce($4, summary), status = coalesce($5, status), priority = coalesce($8, priority),
          lead_id = case when $6::boolean then $7::uuid else lead_id end,
          links = coalesce($9::jsonb, links),
          shipped_at = case when $5='shipped' and status<>'shipped' then now() when $5 is not null and $5<>'shipped' then null else shipped_at end,
          updated_at = now()
        where id=$2::uuid
          and ${MEMBER}
          and ($7::uuid is null or exists (select 1 from public.team_members where profile_id=$7::uuid))
        returning ${PROJECT_COLUMNS}`, [
        memberId, id, change.title ?? null, change.summary ?? null, change.status ?? null, change.leadId !== undefined, change.leadId ?? null,
        change.priority ?? null, change.links ? JSON.stringify(change.links) : null,
      ]);
      return rows[0] ? project(rows[0]) : null;
    },
    async removeProject(memberId, id) {
      // Either member may remove a project; its notes go with it.
      return (await query<{ id: string }>(settings, `delete from public.team_projects where id=$2::uuid and ${MEMBER} returning id::text`, [memberId, id])).length > 0;
    },
    async addNote(memberId, projectId, body) {
      const rows = await query<NoteRow>(settings, `
        with note as (
          insert into public.team_project_notes (project_id, author_id, body)
          select $2::uuid, $1::uuid, $3
          where ${MEMBER}
            and exists (select 1 from public.team_projects where id=$2::uuid)
          returning id, author_id, body, created_at, edited_at, project_id
        ), touched as (update public.team_projects set updated_at=now() where id=(select project_id from note))
        select ${NOTE_COLUMNS} from note`, [memberId, projectId, body]);
      return rows[0] ? note(rows[0]) : null;
    },
    async editNote(memberId, noteId, body) {
      // A note is changed only by whoever wrote it.
      const rows = await query<NoteRow>(settings, `
        update public.team_project_notes set body=$3, edited_at=now()
        where id=$2::uuid and author_id=$1::uuid and ${MEMBER}
        returning ${NOTE_COLUMNS}`, [memberId, noteId, body]);
      return rows[0] ? note(rows[0]) : null;
    },
    async removeNote(memberId, noteId) {
      // A note can only be taken back by whoever wrote it.
      return (await query<{ id: string }>(settings, "delete from public.team_project_notes where id=$2::uuid and author_id=$1::uuid returning id::text", [memberId, noteId])).length > 0;
    },
  };
}
