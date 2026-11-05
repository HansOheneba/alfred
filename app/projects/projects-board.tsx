"use client";

import { useMemo, useState, type FormEvent } from "react";

import { buttonClassName } from "@/app/components/button-styles";
import { requestMutationJson } from "@/app/components/mutation-request";
import { PROJECT_STATUSES, type ProjectNote, type ProjectStatus, type TeamBoard, type TeamProject } from "@/lib/team/types";
import "./projects.css";

const STATUS_LABELS: Record<ProjectStatus, string> = { idea: "Idea", planned: "Planned", building: "Building", shipped: "Shipped", parked: "Parked" };
type Reply<T> = { ok?: boolean; text?: string } & T;

/** Throws the server's own words when a change wasn't saved. */
async function change<T>(body: unknown): Promise<T> {
  const result = await requestMutationJson<Reply<T>>("/api/team", "POST", body);
  if (!result || result.ok === false) throw new Error(result?.text ?? "That change couldn't be saved.");
  return result;
}

const when = (iso: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

/** Ideas the team is working through, who's taking each one, and notes on how to build it. */
export function ProjectsBoard({ me, initial }: { me: string; initial: TeamBoard }) {
  const [projects, setProjects] = useState(initial.projects);
  const [status, setStatus] = useState<ProjectStatus | "all">("all");
  const [lead, setLead] = useState<string>("anyone");
  const [error, setError] = useState<string | null>(null);
  const names = useMemo(() => new Map(initial.members.map((member) => [member.id, member.id === me ? "You" : member.name])), [initial.members, me]);
  const others = initial.members.filter((member) => member.id !== me).map((member) => member.name);
  const shown = projects.filter((item) => (status === "all" || item.status === status) && (lead === "anyone" || (lead === "both" ? item.leadId === null : item.leadId === lead)));
  const counts = useMemo(() => Object.fromEntries(PROJECT_STATUSES.map((value) => [value, projects.filter((item) => item.status === value).length])), [projects]);
  const replace = (next: TeamProject) => setProjects((items) => [next, ...items.filter((item) => item.id !== next.id)]);

  return (
    <div className="alfred-projects">
      <header className="alfred-projects-head">
        <div>
          <h1>Projects</h1>
          <p>Ideas and how to build them{others.length ? `, shared with ${others.join(" and ")}` : ""}. Only the two of you can see this page.</p>
        </div>
      </header>

      <NewProject members={initial.members} me={me} onAdded={(project) => { setProjects((items) => [project, ...items]); setStatus("all"); }} onError={setError} />

      <div className="alfred-projects-filters" role="group" aria-label="Show projects">
        <div className="alfred-projects-chips">
          <button type="button" aria-pressed={status === "all"} onClick={() => setStatus("all")}>All <span>{projects.length}</span></button>
          {PROJECT_STATUSES.map((value) => <button key={value} type="button" aria-pressed={status === value} onClick={() => setStatus(value)}>{STATUS_LABELS[value]} <span>{counts[value]}</span></button>)}
        </div>
        <label className="alfred-projects-leadFilter">
          <span>Taken by</span>
          <select id="projects-lead-filter" value={lead} onChange={(event) => setLead(event.target.value)}>
            <option value="anyone">Anyone</option>
            {initial.members.map((member) => <option key={member.id} value={member.id}>{names.get(member.id)}</option>)}
            <option value="both">Both</option>
          </select>
        </label>
      </div>

      {error ? <p className="alfred-projects-error" role="alert">{error}</p> : null}

      {shown.length ? (
        <ul className="alfred-projects-list">
          {shown.map((item) => <li key={item.id}><ProjectCard project={item} me={me} members={initial.members} names={names} onChange={replace} onError={setError} /></li>)}
        </ul>
      ) : (
        <p className="alfred-projects-empty">{projects.length ? "Nothing matches these filters." : "No projects yet. Add the first idea above, then write notes under it on how you'd build it."}</p>
      )}
    </div>
  );
}

function NewProject({ members, me, onAdded, onError }: { members: TeamBoard["members"]; me: string; onAdded: (project: TeamProject) => void; onError: (text: string | null) => void }) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [leadId, setLeadId] = useState("both");
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    onError(null);
    try {
      const { project } = await change<{ project: TeamProject }>({ action: "add_project", project: { title, summary, leadId: leadId === "both" ? null : leadId } });
      onAdded({ ...project, notes: [] });
      setTitle(""); setSummary(""); setLeadId("both");
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : "That idea couldn't be added.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="alfred-projects-new" onSubmit={submit}>
      <label htmlFor="project-title" className="sr-only">New idea</label>
      <input id="project-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="A new idea…" maxLength={120} autoComplete="off" />
      {title.trim() ? (
        <>
          <label htmlFor="project-summary" className="sr-only">What it is</label>
          <textarea id="project-summary" value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="What it is, in a line or two (optional)" maxLength={2000} rows={2} />
          <div className="alfred-projects-newRow">
            <label>
              <span>Taken by</span>
              <select id="project-lead" value={leadId} onChange={(event) => setLeadId(event.target.value)}>
                <option value="both">Both</option>
                {members.map((member) => <option key={member.id} value={member.id}>{member.id === me ? "Me" : member.name}</option>)}
              </select>
            </label>
            <button type="submit" disabled={saving} className={buttonClassName({ variant: "primary", size: "sm" })}>{saving ? "Adding…" : "Add idea"}</button>
          </div>
        </>
      ) : null}
    </form>
  );
}

function ProjectCard({ project, me, members, names, onChange, onError }: { project: TeamProject; me: string; members: TeamBoard["members"]; names: Map<string, string>; onChange: (project: TeamProject) => void; onError: (text: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(project.title);
  const [summary, setSummary] = useState(project.summary);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function update(changes: Partial<Pick<TeamProject, "title" | "summary" | "status" | "leadId">>) {
    setBusy(true);
    onError(null);
    try {
      const { project: saved } = await change<{ project: TeamProject }>({ action: "update_project", id: project.id, change: changes });
      onChange({ ...saved, notes: project.notes });
      setEditing(false);
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : "That change couldn't be saved.");
    } finally {
      setBusy(false);
    }
  }
  async function addNote(event: FormEvent) {
    event.preventDefault();
    if (!note.trim()) return;
    setBusy(true);
    onError(null);
    try {
      const { note: saved } = await change<{ note: ProjectNote }>({ action: "add_note", projectId: project.id, body: note });
      onChange({ ...project, notes: [...project.notes, saved], updatedAt: saved.createdAt });
      setNote("");
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : "That note couldn't be saved.");
    } finally {
      setBusy(false);
    }
  }
  async function removeNote(id: string) {
    setBusy(true);
    onError(null);
    try {
      await change({ action: "remove_note", noteId: id });
      onChange({ ...project, notes: project.notes.filter((item) => item.id !== id) });
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : "That note couldn't be removed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="alfred-project" data-status={project.status}>
      <div className="alfred-project-top">
        {editing ? (
          <form className="alfred-project-edit" onSubmit={(event) => { event.preventDefault(); void update({ title, summary }); }}>
            <label htmlFor={`title-${project.id}`} className="sr-only">Title</label>
            <input id={`title-${project.id}`} value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required />
            <label htmlFor={`summary-${project.id}`} className="sr-only">What it is</label>
            <textarea id={`summary-${project.id}`} value={summary} onChange={(event) => setSummary(event.target.value)} maxLength={2000} rows={3} placeholder="What it is" />
            <div className="alfred-project-actions">
              <button type="submit" disabled={busy} className={buttonClassName({ variant: "primary", size: "sm" })}>Save</button>
              <button type="button" className={buttonClassName({ variant: "ghost", size: "sm" })} onClick={() => { setEditing(false); setTitle(project.title); setSummary(project.summary); }}>Cancel</button>
            </div>
          </form>
        ) : (
          <button type="button" className="alfred-project-title" aria-expanded={open} onClick={() => setOpen(!open)}>
            <h2>{project.title}</h2>
            {project.summary ? <p>{project.summary}</p> : null}
          </button>
        )}
      </div>
      <div className="alfred-project-meta">
        <label>
          <span className="sr-only">Status</span>
          <select id={`status-${project.id}`} className={`alfred-project-status is-${project.status}`} value={project.status} disabled={busy} onChange={(event) => void update({ status: event.target.value as ProjectStatus })}>
            {PROJECT_STATUSES.map((value) => <option key={value} value={value}>{STATUS_LABELS[value]}</option>)}
          </select>
        </label>
        <label>
          <span className="sr-only">Taken by</span>
          <select id={`lead-${project.id}`} value={project.leadId ?? "both"} disabled={busy} onChange={(event) => void update({ leadId: event.target.value === "both" ? null : event.target.value })}>
            <option value="both">Both</option>
            {members.map((member) => <option key={member.id} value={member.id}>{names.get(member.id)}</option>)}
          </select>
        </label>
        <button type="button" className="alfred-project-notesToggle" aria-expanded={open} onClick={() => setOpen(!open)}>{project.notes.length ? `${project.notes.length} ${project.notes.length === 1 ? "note" : "notes"}` : "Add notes"}</button>
        <span className="alfred-project-when">Updated {when(project.updatedAt)}</span>
      </div>

      {open ? (
        <section className="alfred-project-notes" aria-label={`Notes on ${project.title}`}>
          {project.notes.length ? (
            <ol>
              {project.notes.map((item) => (
                <li key={item.id}>
                  <div className="alfred-project-noteHead">
                    <strong>{names.get(item.authorId) ?? "Teammate"}</strong>
                    <span>{when(item.createdAt)}</span>
                    {item.authorId === me ? <button type="button" disabled={busy} onClick={() => void removeNote(item.id)}>Remove</button> : null}
                  </div>
                  <p>{item.body}</p>
                </li>
              ))}
            </ol>
          ) : <p className="alfred-project-noNotes">No notes yet. How would you build it? What's the first step, what's risky, what's decided?</p>}
          <form onSubmit={addNote} className="alfred-project-addNote">
            <label htmlFor={`note-${project.id}`} className="sr-only">Add a note</label>
            <textarea id={`note-${project.id}`} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add a note on how to build it…" maxLength={4000} rows={3} />
            <div className="alfred-project-actions">
              <button type="submit" disabled={busy || !note.trim()} className={buttonClassName({ variant: "primary", size: "sm" })}>Add note</button>
              {!editing ? <button type="button" className={buttonClassName({ variant: "ghost", size: "sm" })} onClick={() => setEditing(true)}>Edit idea</button> : null}
            </div>
          </form>
        </section>
      ) : null}
    </article>
  );
}
