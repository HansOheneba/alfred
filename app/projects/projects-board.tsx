"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

import { buttonClassName } from "@/app/components/button-styles";
import { requestMutationJson } from "@/app/components/mutation-request";
import { PROJECT_PRIORITIES, PROJECT_STATUSES, type ProjectLink, type ProjectNote, type ProjectPriority, type ProjectStatus, type TeamBoard, type TeamMember, type TeamProject } from "@/lib/team/types";
import "@/app/components/dialog.css";
import "./projects.css";
import { sheetDragProps } from "@/app/components/sheet-drag";

/*
 * The team's projects: a summary of where things stand, then every project
 * grouped by status (or as a board). Tapping one opens a panel with all its
 * fields and the notes thread. Changes save as they're made.
 */

const STATUS: Record<ProjectStatus, { label: string; group: string }> = {
  idea: { label: "Idea", group: "Ideas" }, planned: { label: "Planned", group: "Planned" }, building: { label: "Building", group: "Building" },
  shipped: { label: "Shipped", group: "Shipped" }, parked: { label: "Parked", group: "Parked" },
};
const PRIORITY: Record<ProjectPriority, { label: string; rank: number }> = { high: { label: "High", rank: 3 }, medium: { label: "Medium", rank: 2 }, low: { label: "Low", rank: 1 } };
/** The summary reads from done to set aside, the list puts live work first, the board keeps pipeline order. */
const SUMMARY_ORDER: ProjectStatus[] = ["shipped", "building", "planned", "idea", "parked"];
const LIST_ORDER: ProjectStatus[] = ["building", "planned", "idea", "shipped", "parked"];
const OPEN: ProjectStatus[] = ["idea", "planned", "building"];
const BOTH = "both";
const REFRESH_MS = 60_000;

type Reply<T> = { ok?: boolean; text?: string } & T;
type View = "list" | "board";
type Change = Partial<Pick<TeamProject, "title" | "summary" | "status" | "priority" | "leadId" | "links">>;

/** Throws the server's own words when a change wasn't saved. */
async function change<T>(body: unknown): Promise<T> {
  const result = await requestMutationJson<Reply<T>>("/api/team", "POST", body);
  if (!result || result.ok === false) throw new Error(result?.text ?? "That change couldn't be saved.");
  return result;
}
const message = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback;

function ago(iso: string | null): string {
  if (!iso) return "";
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 86400 * 6) return `${Math.floor(seconds / 86400)}d ago`;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(iso));
}
const fullDate = (iso: string | null) => iso ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "";
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
function linkLabel(link: ProjectLink): string {
  if (link.label) return link.label;
  const pull = link.url.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
  if (pull) return `PR #${pull[1]}`;
  try { return new URL(link.url).hostname.replace(/^www\./, ""); } catch { return link.url; }
}
function sortProjects(items: TeamProject[], status: ProjectStatus): TeamProject[] {
  return [...items].sort((a, b) => status === "shipped"
    ? Date.parse(b.shippedAt ?? b.updatedAt) - Date.parse(a.shippedAt ?? a.updatedAt)
    : PRIORITY[b.priority].rank - PRIORITY[a.priority].rank || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** Each status has its own shape, so it never depends on colour alone. */
function StatusIcon({ status }: { status: ProjectStatus }) {
  return <svg viewBox="0 0 16 16" className="alfred-projects-sicon" data-status={status} aria-hidden="true">
    {status === "idea" ? <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2.4 2.2" /> : null}
    {status === "planned" ? <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" /> : null}
    {status === "building" ? <><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M8 4a4 4 0 0 1 0 8z" fill="currentColor" /></> : null}
    {status === "shipped" ? <><circle cx="8" cy="8" r="7" fill="currentColor" /><path d="M4.8 8.2l2.2 2.2 4.2-4.6" fill="none" stroke="var(--surface)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></> : null}
    {status === "parked" ? <><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M6.4 5.6v4.8M9.6 5.6v4.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></> : null}
  </svg>;
}
const StatusPill = ({ status }: { status: ProjectStatus }) => <span className="alfred-projects-pill" data-status={status}><StatusIcon status={status} />{STATUS[status].label}</span>;
const PriorityPill = ({ priority }: { priority: ProjectPriority }) => <span className="alfred-projects-pill" data-priority={priority}>{PRIORITY[priority].label}</span>;
function OwnerChip({ leadId, names }: { leadId: string | null; names: Map<string, string> }) {
  const name = leadId ? names.get(leadId) ?? "Teammate" : "Both";
  const initials = leadId ? name.slice(0, 1).toUpperCase() : [...names.values()].map((value) => value.slice(0, 1).toUpperCase()).join("+");
  return <span className="alfred-projects-owner"><span className="alfred-projects-avatar" aria-hidden="true">{initials || "B"}</span>{name}</span>;
}

export function ProjectsBoard({ me, initial }: { me: string; initial: TeamBoard }) {
  const [projects, setProjects] = useState(initial.projects);
  const [members] = useState(initial.members);
  const [view, setView] = useState<View>("list");
  const [status, setStatus] = useState<ProjectStatus | "all">("all");
  const [owner, setOwner] = useState<string>("anyone");
  const [highOnly, setHighOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<Partial<Record<ProjectStatus, boolean>>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = useMemo(() => new Map(members.map((member) => [member.id, member.name])), [members]);
  const nameOf = useCallback((id: string) => id === me ? `${names.get(id) ?? "You"} (you)` : names.get(id) ?? "Teammate", [me, names]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("alfred-projects-view");
      // Remembered per device; read after hydration so the server and first paint agree.
      if (saved === "list" || saved === "board") queueMicrotask(() => setView(saved));
    } catch { /* Storage can be unavailable; the list view is the default. */ }
  }, []);
  const pickView = (next: View) => { setView(next); try { localStorage.setItem("alfred-projects-view", next); } catch { /* Not remembered. */ } };

  // The other person's changes arrive when the page comes back into view, and every minute while it's open.
  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch("/api/team", { cache: "no-store" });
        if (!response.ok || stopped) return;
        const board = await response.json() as Reply<TeamBoard>;
        if (board.ok !== false && Array.isArray(board.projects)) setProjects(board.projects);
      } catch { /* Offline: keep what's on screen. */ }
    };
    const timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => { stopped = true; clearInterval(timer); document.removeEventListener("visibilitychange", refresh); window.removeEventListener("focus", refresh); };
  }, []);

  const ownerMatch = useCallback((item: TeamProject) => owner === "anyone" || (owner === BOTH ? item.leadId === null : item.leadId === owner || item.leadId === null), [owner]);
  const scoped = projects.filter(ownerMatch);
  const isHigh = (item: TeamProject) => OPEN.includes(item.status) && item.priority === "high";
  const shown = scoped.filter((item) => (status === "all" || item.status === status) && (!highOnly || isHigh(item)));
  const filtered = owner !== "anyone" || status !== "all" || highOnly;
  const clear = () => { setOwner("anyone"); setStatus("all"); setHighOnly(false); };
  const replace = (next: TeamProject) => setProjects((items) => items.some((item) => item.id === next.id) ? items.map((item) => item.id === next.id ? next : item) : [next, ...items]);
  const open = projects.find((item) => item.id === openId) ?? null;

  return (
    <div className="alfred-projects">
      <header className="alfred-projects-head">
        <div>
          <h1>Projects</h1>
          <p>{members.map((member) => member.name).join(" & ")} · only the two of you can see this</p>
        </div>
        <div className="alfred-projects-headActions">
          <div className="alfred-projects-tabs" role="group" aria-label="View">
            <button type="button" aria-pressed={view === "list"} onClick={() => pickView("list")}>List</button>
            <button type="button" aria-pressed={view === "board"} onClick={() => pickView("board")}>Board</button>
          </div>
          <button type="button" className={buttonClassName({ variant: "primary" })} onClick={() => setCreating(true)}>New idea</button>
        </div>
      </header>

      {error ? <p className="alfred-projects-error" role="alert">{error}</p> : null}

      {projects.length ? <>
        <Summary items={scoped} status={status} setStatus={setStatus} highOnly={highOnly} setHighOnly={setHighOnly} />
        <div className="alfred-projects-toolbar">
          <span className="alfred-projects-label" id="projects-owner-label">Owner</span>
          <div className="alfred-projects-owners" role="group" aria-labelledby="projects-owner-label">
            {[["anyone", "Anyone"], ...members.map((member) => [member.id, member.name]), [BOTH, "Both"]].map(([value, label]) => (
              <button key={value} type="button" aria-pressed={owner === value} title={value !== "anyone" && value !== BOTH ? `${label}'s projects and shared ones` : undefined} onClick={() => setOwner(value)}>{label}</button>
            ))}
          </div>
          {filtered ? <span className="alfred-projects-showing">Showing {shown.length} of {projects.length}<button type="button" onClick={clear}>Clear filters</button></span> : null}
        </div>
        {view === "board"
          ? <Board items={shown} only={status} names={names} onOpen={setOpenId} />
          : <List items={shown} only={status} filtered={filtered} collapsed={collapsed} toggle={(key) => setCollapsed((value) => ({ ...value, [key]: !value[key] }))} names={names} onOpen={setOpenId} clear={clear} />}
      </> : (
        <div className="alfred-projects-empty">
          <strong>No projects yet.</strong>
          <span>Tap New idea to add the first one. Every project gets an owner, a status and a thread of notes on how to build it.</span>
        </div>
      )}

      {open ? <ProjectPanel key={open.id} project={open} me={me} members={members} nameOf={nameOf} onClose={() => setOpenId(null)} onChange={replace}
        onRemoved={() => { setProjects((items) => items.filter((item) => item.id !== open.id)); setOpenId(null); }} /> : null}
      {creating ? <NewProject members={members} me={me} onClose={() => setCreating(false)} onAdded={(project) => { replace(project); setCreating(false); setOpenId(project.id); }} onError={setError} /> : null}
    </div>
  );
}

function Summary({ items, status, setStatus, highOnly, setHighOnly }: { items: TeamProject[]; status: ProjectStatus | "all"; setStatus: (value: ProjectStatus | "all") => void; highOnly: boolean; setHighOnly: (value: boolean) => void }) {
  const count = (key: ProjectStatus) => items.filter((item) => item.status === key).length;
  const shipped = count("shipped"), total = items.length, percent = total ? Math.round(shipped / total * 100) : 0;
  const last = sortProjects(items.filter((item) => item.status === "shipped"), "shipped")[0];
  const building = sortProjects(items.filter((item) => item.status === "building"), "building");
  const high = items.filter((item) => OPEN.includes(item.status) && item.priority === "high").length;
  return (
    <section className="alfred-projects-summary" aria-label="Where things stand">
      <div className="alfred-projects-sumHead">
        <h2>{shipped} of {plural(total, "project", "projects")} shipped</h2>
        <span className="alfred-projects-pct">{percent}%</span>
        {last ? <span className="alfred-projects-last">Last shipped: <b>{last.title}</b>, {ago(last.shippedAt ?? last.updatedAt)}</span> : null}
      </div>
      <div className="alfred-projects-bar" role="img" aria-label={SUMMARY_ORDER.map((key) => `${STATUS[key].label} ${count(key)}`).join(", ")}>
        {SUMMARY_ORDER.map((key) => count(key) ? <i key={key} data-status={key} style={{ flexGrow: count(key) }} title={`${STATUS[key].label}: ${count(key)}`} /> : null)}
      </div>
      <div className="alfred-projects-tiles" role="group" aria-label="Show one status">
        {SUMMARY_ORDER.map((key) => (
          <button key={key} type="button" data-status={key} aria-pressed={status === key} aria-label={`${STATUS[key].label}: ${count(key)}. Show only ${STATUS[key].label}.`} onClick={() => setStatus(status === key ? "all" : key)}>
            <span className="alfred-projects-num">{count(key)}</span>
            <span className="alfred-projects-tileLabel"><StatusIcon status={key} />{STATUS[key].label}</span>
          </button>
        ))}
      </div>
      <div className="alfred-projects-attention">
        {high || highOnly ? <button type="button" aria-pressed={highOnly} onClick={() => setHighOnly(!highOnly)}>{high} high priority, not shipped yet</button> : null}
        {building.length
          ? <span>Building now: <b>{building.slice(0, 2).map((item) => item.title).join(", ")}</b>{building.length > 2 ? ` and ${building.length - 2} more` : ""}</span>
          : items.some((item) => OPEN.includes(item.status)) ? <span>Nothing is being built right now.</span> : null}
      </div>
    </section>
  );
}

function rowMeta(item: TeamProject): string {
  const parts: string[] = [];
  if (item.links.length) parts.push(linkLabel(item.links[0]) + (item.links.length > 1 ? ` +${item.links.length - 1}` : ""));
  if (item.notes.length) parts.push(plural(item.notes.length, "note", "notes"));
  return parts.join(", ");
}

function List({ items, only, filtered, collapsed, toggle, names, onOpen, clear }: {
  items: TeamProject[]; only: ProjectStatus | "all"; filtered: boolean; collapsed: Partial<Record<ProjectStatus, boolean>>;
  toggle: (status: ProjectStatus) => void; names: Map<string, string>; onOpen: (id: string) => void; clear: () => void;
}) {
  const groups = LIST_ORDER.filter((key) => only === "all" || only === key).map((key) => ({ key, items: sortProjects(items.filter((item) => item.status === key), key) })).filter((group) => group.items.length || !filtered);
  if (!groups.length) return <p className="alfred-projects-none">Nothing matches these filters. <button type="button" onClick={clear}>Clear filters</button></p>;
  return (
    <div className="alfred-projects-list">
      <div className="alfred-projects-thead" aria-hidden="true"><span>Name</span><span>Owner</span><span>Priority</span><span>Status</span><span>Updated</span><span>Links and notes</span></div>
      {groups.map(({ key, items: rows }) => (
        <section key={key} className="alfred-projects-group" aria-label={STATUS[key].group}>
          <button type="button" className="alfred-projects-groupHead" data-status={key} aria-expanded={!collapsed[key]} onClick={() => toggle(key)}>
            <svg viewBox="0 0 16 16" className="alfred-projects-chev" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <StatusIcon status={key} />{STATUS[key].group}<span>{rows.length}</span>
          </button>
          {collapsed[key] ? null : <div className="alfred-projects-rows">
            {rows.length ? rows.map((item) => {
              const time = item.status === "shipped" ? item.shippedAt ?? item.updatedAt : item.updatedAt;
              return (
                <button key={item.id} type="button" className="alfred-projects-row" onClick={() => onOpen(item.id)}>
                  <span className="alfred-projects-name"><StatusIcon status={item.status} /><span><span className="alfred-projects-title">{item.title}</span>{item.summary ? <span className="alfred-projects-desc">{item.summary}</span> : null}</span></span>
                  <span className="alfred-projects-metas">
                    <OwnerChip leadId={item.leadId} names={names} />
                    <PriorityPill priority={item.priority} />
                    <StatusPill status={item.status} />
                    <span className="alfred-projects-cell" title={fullDate(time)}>{ago(time)}</span>
                    <span className="alfred-projects-cell">{rowMeta(item)}</span>
                  </span>
                </button>
              );
            }) : <p className="alfred-projects-nothing">Nothing here.</p>}
          </div>}
        </section>
      ))}
    </div>
  );
}

function Board({ items, only, names, onOpen }: { items: TeamProject[]; only: ProjectStatus | "all"; names: Map<string, string>; onOpen: (id: string) => void }) {
  return (
    <div className="alfred-projects-board">
      {PROJECT_STATUSES.filter((key) => only === "all" || only === key).map((key) => {
        const cards = sortProjects(items.filter((item) => item.status === key), key);
        return (
          <section key={key} className="alfred-projects-col" aria-label={STATUS[key].group}>
            <div className="alfred-projects-colHead" data-status={key}><StatusIcon status={key} />{STATUS[key].group}<span>{cards.length}</span></div>
            {cards.length ? cards.map((item) => (
              <button key={item.id} type="button" className="alfred-projects-card" onClick={() => onOpen(item.id)}>
                <span className="alfred-projects-title">{item.title}</span>
                {item.summary ? <span className="alfred-projects-desc">{item.summary}</span> : null}
                <span className="alfred-projects-cardMeta"><OwnerChip leadId={item.leadId} names={names} /><PriorityPill priority={item.priority} />{rowMeta(item) ? <span>{rowMeta(item)}</span> : null}</span>
              </button>
            )) : <p className="alfred-projects-nothing">Nothing here.</p>}
          </section>
        );
      })}
    </div>
  );
}

/** A native dialog: it traps focus, closes on Escape and covers the tab bar on phones. */
function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  return (
    <dialog ref={ref} className="alfred-dialog alfred-projects-panel" aria-label={title} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="alfred-dialog-surface">
        <span className="alfred-sheet-handle" data-sheet-handle aria-hidden="true" {...sheetDragProps(onClose)} />
        <div className="alfred-dialog-header" {...sheetDragProps(onClose)}><h2>{title}</h2><button type="button" className={buttonClassName({ variant: "ghost", size: "sm" })} onClick={onClose}>Close</button></div>
        <div className="alfred-dialog-body">{children}</div>
      </div>
    </dialog>
  );
}

function ProjectPanel({ project, me, members, nameOf, onClose, onChange, onRemoved }: {
  project: TeamProject; me: string; members: TeamMember[]; nameOf: (id: string) => string;
  onClose: () => void; onChange: (project: TeamProject) => void; onRemoved: () => void;
}) {
  const [title, setTitle] = useState(project.title);
  const [summary, setSummary] = useState(project.summary);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkName, setLinkName] = useState("");
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(project);
  useEffect(() => { latest.current = project; }, [project]);

  async function run(work: () => Promise<void>, fallback: string) {
    setBusy(true); setError(null);
    try { await work(); } catch (failure) { setError(message(failure, fallback)); } finally { setBusy(false); }
  }
  const update = (changes: Change) => run(async () => {
    const { project: saved } = await change<{ project: TeamProject }>({ action: "update_project", id: project.id, change: changes });
    onChange({ ...saved, notes: latest.current.notes });
  }, "That change couldn't be saved.");
  const saveText = () => {
    const next: Change = {};
    if (title.trim() && title.trim() !== project.title) next.title = title.trim();
    if (summary.trim() !== project.summary) next.summary = summary.trim();
    if (Object.keys(next).length) void update(next);
  };
  function addLink(event: FormEvent) {
    event.preventDefault();
    const url = linkUrl.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) { setError("Paste a full link starting with https://"); return; }
    void update({ links: [...project.links, { url, label: linkName.trim() }] }).then(() => { setLinkUrl(""); setLinkName(""); });
  }
  const addNote = (event: FormEvent) => {
    event.preventDefault();
    if (!note.trim()) return;
    void run(async () => {
      const { note: saved } = await change<{ note: ProjectNote }>({ action: "add_note", projectId: project.id, body: note });
      onChange({ ...latest.current, notes: [...latest.current.notes, saved], updatedAt: saved.createdAt });
      setNote("");
    }, "That note couldn't be saved.");
  };
  const saveNote = () => editing && editing.body.trim() && run(async () => {
    const { note: saved } = await change<{ note: ProjectNote }>({ action: "edit_note", noteId: editing.id, body: editing.body });
    onChange({ ...latest.current, notes: latest.current.notes.map((item) => item.id === saved.id ? saved : item) });
    setEditing(null);
  }, "That note couldn't be saved.");
  const removeNote = (id: string) => {
    if (confirm !== id) { setConfirm(id); return; }
    setConfirm(null);
    void run(async () => {
      await change({ action: "remove_note", noteId: id });
      onChange({ ...latest.current, notes: latest.current.notes.filter((item) => item.id !== id) });
    }, "That note couldn't be removed.");
  };
  const removeProject = () => {
    if (confirm !== "project") { setConfirm("project"); return; }
    void run(async () => { await change({ action: "remove_project", id: project.id }); onRemoved(); }, "That project couldn't be removed.");
  };

  return (
    <Panel title="Project" onClose={onClose}>
      <div className="alfred-projects-fields">
        <label className="alfred-projects-field"><span className="sr-only">Title</span>
          <input id="project-panel-title" className="alfred-projects-titleInput" value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} onBlur={saveText} />
        </label>
        <div className="alfred-projects-field">
          <span className="alfred-projects-label">Status</span>
          <div className="alfred-projects-pipeline" role="group" aria-label="Status">
            {PROJECT_STATUSES.map((key) => <button key={key} type="button" data-status={key} aria-pressed={project.status === key} disabled={busy} onClick={() => project.status !== key && void update({ status: key })}><StatusIcon status={key} />{STATUS[key].label}</button>)}
          </div>
        </div>
        <div className="alfred-projects-pair">
          <label className="alfred-projects-field"><span className="alfred-projects-label">Owner</span>
            <select id="project-panel-owner" value={project.leadId ?? BOTH} disabled={busy} onChange={(event) => void update({ leadId: event.target.value === BOTH ? null : event.target.value })}>
              {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
              <option value={BOTH}>Both</option>
            </select>
          </label>
          <label className="alfred-projects-field"><span className="alfred-projects-label">Priority</span>
            <select id="project-panel-priority" value={project.priority} disabled={busy} onChange={(event) => void update({ priority: event.target.value as ProjectPriority })}>
              {PROJECT_PRIORITIES.map((key) => <option key={key} value={key}>{PRIORITY[key].label}</option>)}
            </select>
          </label>
        </div>
        <label className="alfred-projects-field"><span className="alfred-projects-label">Description</span>
          <textarea id="project-panel-summary" value={summary} maxLength={2000} rows={3} placeholder="What it is, in a sentence or two" onChange={(event) => setSummary(event.target.value)} onBlur={saveText} />
        </label>
        <div className="alfred-projects-field">
          <span className="alfred-projects-label">Links</span>
          {project.links.length ? <ul className="alfred-projects-links">
            {project.links.map((link, index) => (
              <li key={`${link.url}-${index}`}>
                <a href={link.url} target="_blank" rel="noopener noreferrer">{linkLabel(link)}</a>
                <span>{link.url}</span>
                <button type="button" disabled={busy} aria-label={`Remove link ${linkLabel(link)}`} onClick={() => void update({ links: project.links.filter((_, other) => other !== index) })}>Remove</button>
              </li>
            ))}
          </ul> : <p className="alfred-projects-hint">No links yet. Add a reference, video, PR or doc.</p>}
          <form className="alfred-projects-addLink" onSubmit={addLink}>
            <label htmlFor="project-link-name" className="sr-only">Link label</label>
            <input id="project-link-name" value={linkName} maxLength={80} placeholder="Label (optional)" onChange={(event) => setLinkName(event.target.value)} />
            <label htmlFor="project-link-url" className="sr-only">Link</label>
            <input id="project-link-url" value={linkUrl} maxLength={500} inputMode="url" placeholder="https://…" onChange={(event) => setLinkUrl(event.target.value)} />
            <button type="submit" disabled={busy || !linkUrl.trim() || project.links.length >= 12} className={buttonClassName({ variant: "secondary", size: "sm" })}>Add</button>
          </form>
        </div>
      </div>

      <section className="alfred-projects-thread" aria-label="Notes">
        <span className="alfred-projects-label">Notes on how to build it</span>
        {project.notes.length ? project.notes.map((item) => (
          <article key={item.id} className="alfred-projects-note">
            <div className="alfred-projects-noteHead"><b>{nameOf(item.authorId)}</b><span title={fullDate(item.createdAt)}>{ago(item.createdAt)}{item.editedAt ? ` · edited ${ago(item.editedAt)}` : ""}</span></div>
            {editing?.id === item.id ? <>
              <label htmlFor={`note-edit-${item.id}`} className="sr-only">Edit note</label>
              <textarea id={`note-edit-${item.id}`} value={editing.body} maxLength={4000} rows={4} autoFocus onChange={(event) => setEditing({ id: item.id, body: event.target.value })} />
              <div className="alfred-projects-noteActions">
                <button type="button" onClick={() => setEditing(null)}>Cancel</button>
                <button type="button" disabled={busy || !editing.body.trim()} onClick={() => void saveNote()}>Save</button>
              </div>
            </> : <>
              <p>{item.body}</p>
              {item.authorId === me ? <div className="alfred-projects-noteActions">
                <button type="button" onClick={() => { setConfirm(null); setEditing({ id: item.id, body: item.body }); }}>Edit</button>
                <button type="button" disabled={busy} onClick={() => removeNote(item.id)}>{confirm === item.id ? "Tap again to delete" : "Delete"}</button>
              </div> : null}
            </>}
          </article>
        )) : <p className="alfred-projects-hint">No notes yet. Start with the approach you have in mind: first step, what&apos;s risky, what&apos;s decided.</p>}
        <form className="alfred-projects-composer" onSubmit={addNote}>
          <label htmlFor="project-note-new" className="sr-only">Add a note</label>
          <textarea id="project-note-new" value={note} maxLength={4000} rows={3} placeholder="How should we build this? Approach, tools, risks, decisions…" onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit(); }} />
          <div className="alfred-projects-composerBar">
            <span className="alfred-projects-hint">Notes show your name and the time.</span>
            <button type="submit" disabled={busy || !note.trim()} className={buttonClassName({ variant: "primary", size: "sm" })}>Add note</button>
          </div>
        </form>
      </section>

      {error ? <p className="alfred-projects-error" role="alert">{error}</p> : null}
      <footer className="alfred-projects-foot">
        <span>Added by {nameOf(project.createdBy)} · {ago(project.createdAt)}{project.updatedAt !== project.createdAt ? ` · last change ${ago(project.updatedAt)}` : ""}</span>
        <button type="button" className={buttonClassName({ variant: "ghost", size: "sm", className: "alfred-projects-danger" })} disabled={busy} onClick={removeProject}>{confirm === "project" ? "Tap again to delete for good" : "Delete project"}</button>
      </footer>
    </Panel>
  );
}

function NewProject({ members, me, onClose, onAdded, onError }: { members: TeamMember[]; me: string; onClose: () => void; onAdded: (project: TeamProject) => void; onError: (text: string | null) => void }) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [leadId, setLeadId] = useState(BOTH);
  const [priority, setPriority] = useState<ProjectPriority>("medium");
  const [status, setStatus] = useState<ProjectStatus>("idea");
  const [first, setFirst] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setSaving(true); setError(null); onError(null);
    try {
      const { project } = await change<{ project: TeamProject }>({ action: "add_project", project: { title, summary, status, priority, leadId: leadId === BOTH ? null : leadId, links: [] } });
      let notes: ProjectNote[] = [];
      if (first.trim()) {
        try { notes = [(await change<{ note: ProjectNote }>({ action: "add_note", projectId: project.id, body: first })).note]; }
        catch { onError("The idea was added, but its first note wasn't saved. Add it again from the project."); }
      }
      onAdded({ ...project, notes });
    } catch (failure) {
      setError(message(failure, "That idea couldn't be added."));
      setSaving(false);
    }
  }
  return (
    <Panel title="New idea" onClose={onClose}>
      <form className="alfred-projects-fields" onSubmit={submit}>
        <label className="alfred-projects-field"><span className="alfred-projects-label">Title</span>
          <input id="project-new-title" value={title} maxLength={120} required autoFocus autoComplete="off" placeholder="What's the idea?" onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="alfred-projects-field"><span className="alfred-projects-label">Description</span>
          <textarea id="project-new-summary" value={summary} maxLength={2000} rows={2} placeholder="A sentence or two on what it is and why" onChange={(event) => setSummary(event.target.value)} />
        </label>
        <div className="alfred-projects-pair">
          <label className="alfred-projects-field"><span className="alfred-projects-label">Owner</span>
            <select id="project-new-owner" value={leadId} onChange={(event) => setLeadId(event.target.value)}>
              <option value={BOTH}>Both</option>
              {members.map((member) => <option key={member.id} value={member.id}>{member.id === me ? `${member.name} (you)` : member.name}</option>)}
            </select>
          </label>
          <label className="alfred-projects-field"><span className="alfred-projects-label">Priority</span>
            <select id="project-new-priority" value={priority} onChange={(event) => setPriority(event.target.value as ProjectPriority)}>
              {PROJECT_PRIORITIES.map((key) => <option key={key} value={key}>{PRIORITY[key].label}</option>)}
            </select>
          </label>
        </div>
        <label className="alfred-projects-field"><span className="alfred-projects-label">Status</span>
          <select id="project-new-status" value={status} onChange={(event) => setStatus(event.target.value as ProjectStatus)}>
            {PROJECT_STATUSES.map((key) => <option key={key} value={key}>{STATUS[key].label}</option>)}
          </select>
        </label>
        <label className="alfred-projects-field"><span className="alfred-projects-label">First note</span>
          <textarea id="project-new-note" value={first} maxLength={4000} rows={3} placeholder="How you'd start building it (optional)" onChange={(event) => setFirst(event.target.value)} />
        </label>
        {error ? <p className="alfred-projects-error" role="alert">{error}</p> : null}
        <div><button type="submit" disabled={saving || !title.trim()} className={buttonClassName({ variant: "primary" })}>{saving ? "Adding…" : "Add idea"}</button></div>
      </form>
    </Panel>
  );
}
