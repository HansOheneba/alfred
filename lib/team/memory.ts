import type { TeamStore } from "@/lib/team/store";
import type { ProjectNote, TeamMember, TeamProject } from "@/lib/team/types";

/** The team's projects held in memory, with the same membership rules as the database, for tests and evals. */
export class MemoryTeamStore implements TeamStore {
  projects: TeamProject[] = [];
  private sequence = 0;
  constructor(public members: TeamMember[]) {}
  private id() { return `00000000-0000-4000-8000-${String(++this.sequence).padStart(12, "0")}`; }
  private member(id: string | null) { return id === null || this.members.some((item) => item.id === id); }
  async isMember(profileId: string) { return this.members.some((item) => item.id === profileId); }
  async board(memberId: string) {
    return await this.isMember(memberId) ? { members: this.members, projects: [...this.projects].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)) } : null;
  }
  async addProject(memberId: string, input: Parameters<TeamStore["addProject"]>[1]) {
    if (!await this.isMember(memberId) || !this.member(input.leadId)) return null;
    const now = new Date(Date.now() + this.sequence).toISOString();
    const project: TeamProject = { id: this.id(), title: input.title, summary: input.summary, status: input.status, priority: input.priority, leadId: input.leadId, links: input.links,
      createdBy: memberId, createdAt: now, updatedAt: now, shippedAt: input.status === "shipped" ? now : null, notes: [] };
    this.projects.push(project);
    return project;
  }
  async updateProject(memberId: string, id: string, change: Parameters<TeamStore["updateProject"]>[2]) {
    const project = this.projects.find((item) => item.id === id);
    if (!project || !await this.isMember(memberId) || (change.leadId !== undefined && !this.member(change.leadId))) return null;
    Object.assign(project, Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined)), { updatedAt: new Date(Date.now() + ++this.sequence).toISOString() });
    if (change.status === "shipped" && !project.shippedAt) project.shippedAt = project.updatedAt;
    return project;
  }
  async removeProject(memberId: string, id: string) {
    if (!await this.isMember(memberId)) return false;
    const before = this.projects.length;
    this.projects = this.projects.filter((item) => item.id !== id);
    return this.projects.length < before;
  }
  async addNote(memberId: string, projectId: string, body: string) {
    const project = this.projects.find((item) => item.id === projectId);
    if (!project || !await this.isMember(memberId)) return null;
    const note: ProjectNote = { id: this.id(), authorId: memberId, body, createdAt: new Date().toISOString(), editedAt: null };
    project.notes.push(note);
    project.updatedAt = note.createdAt;
    return note;
  }
  async editNote(memberId: string, noteId: string, body: string) {
    const note = this.projects.flatMap((item) => item.notes).find((item) => item.id === noteId && item.authorId === memberId);
    if (!note) return null;
    Object.assign(note, { body, editedAt: new Date().toISOString() });
    return note;
  }
  async removeNote(memberId: string, noteId: string) {
    for (const project of this.projects) {
      const before = project.notes.length;
      project.notes = project.notes.filter((item) => !(item.id === noteId && item.authorId === memberId));
      if (project.notes.length < before) return true;
    }
    return false;
  }
}
