import { z } from "zod";

import { logError } from "@/lib/log";
import { createSupabaseTeamStore, newProjectSchema, noteSchema, projectChangeSchema } from "@/lib/team/store";
import { fail, readBody, requireOwner } from "@/lib/web/api";

/**
 * The team's shared projects. Anyone who isn't a member gets the same 404 a
 * missing page would, so the space doesn't advertise itself.
 */

const NOT_FOUND = "Not found.";
const NO_STORE = { "Cache-Control": "private, no-store" };

const changeBody = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("add_project"), project: newProjectSchema }),
  z.strictObject({ action: z.literal("update_project"), id: z.string().uuid(), change: projectChangeSchema }),
  z.strictObject({ action: z.literal("add_note"), projectId: z.string().uuid(), body: noteSchema }),
  z.strictObject({ action: z.literal("remove_note"), noteId: z.string().uuid() }),
]);

export async function GET(): Promise<Response> {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  try {
    const board = await createSupabaseTeamStore(owner.settings.supabase).board(owner.profile.profileId);
    return board ? Response.json({ ok: true, ...board }, { headers: NO_STORE }) : fail(NOT_FOUND, 404);
  } catch (error) {
    logError("team_board", error);
    return fail("The projects couldn't be loaded.", 500);
  }
}

export async function POST(request: Request): Promise<Response> {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  const store = createSupabaseTeamStore(owner.settings.supabase);
  const memberId = owner.profile.profileId;
  try {
    // Check membership before reading the body, so a non-member learns nothing from validation errors.
    if (!await store.isMember(memberId)) return fail(NOT_FOUND, 404);
    const body = await readBody(request, changeBody);
    if (body instanceof Response) return body;
    if (body.action === "add_project") {
      const project = await store.addProject(memberId, body.project);
      return project ? Response.json({ ok: true, project }, { headers: NO_STORE }) : fail("Pick someone on the team to take it, or leave it for both.", 400);
    }
    if (body.action === "update_project") {
      const project = await store.updateProject(memberId, body.id, body.change);
      return project ? Response.json({ ok: true, project }, { headers: NO_STORE }) : fail("That project is gone, or the person picked isn't on the team.", 404);
    }
    if (body.action === "add_note") {
      const note = await store.addNote(memberId, body.projectId, body.body);
      return note ? Response.json({ ok: true, note }, { headers: NO_STORE }) : fail("That project is gone.", 404);
    }
    return await store.removeNote(memberId, body.noteId) ? Response.json({ ok: true }, { headers: NO_STORE }) : fail("Only the person who wrote a note can remove it.", 403);
  } catch (error) {
    logError("team_change", error);
    return fail("That change couldn't be saved.", 500);
  }
}
