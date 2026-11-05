import type { TeamStore } from "@/lib/team/store";
import type { ProjectLink, ProjectPriority, ProjectStatus, TeamBoard, TeamProject } from "@/lib/team/types";

/**
 * Managing the team's projects by talking to Alfred: add an idea, move it
 * along, change who's taking it, add a note or a link, list them, or remove
 * one after a yes. Only members ever get here; the projects are side
 * projects, so nothing touches anyone's money.
 */

export type TeamAccess = { store: TeamStore; memberId: string };

export type ProjectRequest = {
  op: "list" | "add" | "update" | "note" | "remove";
  project?: string | null;
  title?: string | null;
  summary?: string | null;
  status?: ProjectStatus | null;
  priority?: ProjectPriority | null;
  lead?: "me" | "other" | "both" | null;
  link?: { url: string; label?: string | null } | null;
  note?: string | null;
};

const STATUS: Record<ProjectStatus, string> = { idea: "an idea", planned: "planned", building: "building", shipped: "shipped", parked: "parked" };
const STATUS_HEADINGS: Record<ProjectStatus, string> = { building: "Building", planned: "Planned", idea: "Ideas", shipped: "Shipped", parked: "Parked" };

/** The other member's name, or "both of you"/"you" for the rest. */
function leadName(board: TeamBoard, me: string, leadId: string | null): string {
  if (leadId === null) return "both of you";
  if (leadId === me) return "you";
  return board.members.find((member) => member.id === leadId)?.name ?? "a teammate";
}

/** The person a lead word means: me, the one other member, or nobody in particular. Undefined when it can't be told. */
function leadId(board: TeamBoard, me: string, lead: ProjectRequest["lead"]): string | null | undefined {
  if (lead === "me") return me;
  if (lead === "both") return null;
  if (lead === "other") {
    const others = board.members.filter((member) => member.id !== me);
    return others.length === 1 ? others[0].id : undefined;
  }
  return undefined;
}

/** The project they mean by name: an exact match, else the one title that contains it or shares its words. */
export function findProject(projects: TeamProject[], name: string): TeamProject[] {
  const wanted = name.trim().toLowerCase().replace(/[“”"']/g, "");
  if (!wanted) return [];
  const exact = projects.filter((item) => item.title.toLowerCase() === wanted);
  if (exact.length) return exact;
  const containing = projects.filter((item) => item.title.toLowerCase().includes(wanted) || wanted.includes(item.title.toLowerCase()));
  if (containing.length) return containing;
  const words = wanted.split(/\W+/).filter((word) => word.length > 2 && !["the", "and", "app", "for", "project"].includes(word));
  return projects.filter((item) => words.some((word) => item.title.toLowerCase().includes(word)));
}

/** One line per project for the model, so "move bubble bliss along" knows what exists. */
export function projectLines(board: TeamBoard, me: string): string[] {
  return board.projects.map((item) => `${item.title}: ${item.status}, ${item.priority} priority, taken by ${leadName(board, me, item.leadId)}${item.notes.length ? `, ${item.notes.length} note${item.notes.length === 1 ? "" : "s"}` : ""}`);
}

export type ProjectOutcome = { text: string } | { confirm: { text: string; projectId: string; title: string } };

export async function manageProject(request: ProjectRequest, access: TeamAccess): Promise<ProjectOutcome> {
  const { store, memberId: me } = access;
  const board = await store.board(me);
  if (!board) return { text: "I can't help with that here." };
  const link = (value: ProjectRequest["link"]): ProjectLink | null => value?.url && /^https?:\/\//i.test(value.url) ? { url: value.url.trim(), label: value.label?.trim() ?? "" } : null;

  if (request.op === "list") {
    if (!board.projects.length) return { text: "There are no projects yet. Tell me an idea and I'll add it." };
    const groups = (["building", "planned", "idea", "shipped", "parked"] as ProjectStatus[]).flatMap((status) => {
      const items = board.projects.filter((item) => item.status === status);
      return items.length ? [`${STATUS_HEADINGS[status]}:`, ...items.map((item) => `• ${item.title} (${leadName(board, me, item.leadId)}, ${item.priority} priority)`)] : [];
    });
    return { text: [...groups, "", "They're all under Settings → Projects too."].join("\n") };
  }

  if (request.op === "add") {
    const title = request.title?.trim() || request.project?.trim();
    if (!title) return { text: "What should the idea be called?" };
    if (findProject(board.projects, title).some((item) => item.title.toLowerCase() === title.toLowerCase())) return { text: `“${title}” is already a project. Want me to update it instead?` };
    const lead = request.lead ? leadId(board, me, request.lead) : null;
    if (lead === undefined) return { text: "Who's taking it: you, the other person, or both of you?" };
    const added = await store.addProject(me, { title: title.slice(0, 120), summary: request.summary?.trim().slice(0, 2000) ?? "", status: request.status ?? "idea", priority: request.priority ?? "medium", leadId: lead, links: link(request.link) ? [link(request.link)!] : [] });
    if (!added) return { text: "That idea couldn't be added. Nothing was changed." };
    if (request.note?.trim()) await store.addNote(me, added.id, request.note.trim().slice(0, 4000));
    return { text: `Added “${added.title}” as ${STATUS[added.status]}, taken by ${leadName(board, me, added.leadId)}, ${added.priority} priority${request.note?.trim() ? ", with your note" : ""}.` };
  }

  const matches = request.project ? findProject(board.projects, request.project) : [];
  if (matches.length !== 1) {
    const names = board.projects.map((item) => `“${item.title}”`).join(", ");
    return { text: matches.length > 1 ? `Which one: ${matches.map((item) => `“${item.title}”`).join(" or ")}?` : board.projects.length ? `Which project do you mean? You have ${names}.` : "There are no projects yet. Tell me an idea and I'll add it." };
  }
  const project = matches[0];

  if (request.op === "note") {
    const body = request.note?.trim();
    if (!body) return { text: `What's the note for “${project.title}”?` };
    const saved = await store.addNote(me, project.id, body.slice(0, 4000));
    return { text: saved ? `Added your note to “${project.title}”.` : "That note couldn't be saved. Nothing was changed." };
  }

  if (request.op === "remove") {
    return { confirm: { projectId: project.id, title: project.title, text: `Remove “${project.title}”${project.notes.length ? ` and its ${project.notes.length} note${project.notes.length === 1 ? "" : "s"}` : ""}? This can't be undone.\n\nConfirm or cancel.` } };
  }

  // Update: only what they asked to change.
  const change: Parameters<TeamStore["updateProject"]>[2] = {};
  const said: string[] = [];
  if (request.title?.trim() && request.title.trim() !== project.title) { change.title = request.title.trim().slice(0, 120); said.push(`renamed to “${change.title}”`); }
  if (request.summary?.trim()) { change.summary = request.summary.trim().slice(0, 2000); said.push("description updated"); }
  if (request.status && request.status !== project.status) { change.status = request.status; said.push(`moved to ${request.status}`); }
  if (request.priority && request.priority !== project.priority) { change.priority = request.priority; said.push(`set to ${request.priority} priority`); }
  if (request.lead) {
    const lead = leadId(board, me, request.lead);
    if (lead === undefined) return { text: "Who's taking it: you, the other person, or both of you?" };
    if (lead !== project.leadId) { change.leadId = lead; said.push(`now taken by ${leadName(board, me, lead)}`); }
  }
  const added = link(request.link);
  if (added && !project.links.some((item) => item.url === added.url)) {
    if (project.links.length >= 12) return { text: `“${project.title}” already has 12 links. Remove one on the Projects page first.` };
    change.links = [...project.links, added];
    said.push("link added");
  }
  if (request.note?.trim()) await store.addNote(me, project.id, request.note.trim().slice(0, 4000));
  if (!said.length) return { text: request.note?.trim() ? `Added your note to “${project.title}”.` : `“${project.title}” already looks like that. What would you like to change?` };
  const saved = await store.updateProject(me, project.id, change);
  if (!saved) return { text: "That change couldn't be saved. Nothing was changed." };
  const list = said.length > 1 ? `${said.slice(0, -1).join(", ")} and ${said.at(-1)}` : said[0];
  return { text: `Updated “${saved.title}”: ${list}${request.note?.trim() ? ", and your note added" : ""}.` };
}
