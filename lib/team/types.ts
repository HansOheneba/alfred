import { z } from "zod";

/** What the team's projects look like, shared by the server and the page. No database code here. */

export const PROJECT_STATUSES = ["idea", "planned", "building", "shipped", "parked"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export type TeamMember = { id: string; name: string };
export type ProjectNote = { id: string; authorId: string; body: string; createdAt: string };
export type TeamProject = {
  id: string; title: string; summary: string; status: ProjectStatus;
  /** One member taking it, or null for both. */
  leadId: string | null;
  createdBy: string; createdAt: string; updatedAt: string;
  notes: ProjectNote[];
};
export type TeamBoard = { members: TeamMember[]; projects: TeamProject[] };

const text = (max: number) => z.string().trim().max(max);
export const newProjectSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  summary: text(2000).default(""),
  status: z.enum(PROJECT_STATUSES).default("idea"),
  leadId: z.string().uuid().nullable().default(null),
});
export const projectChangeSchema = z.strictObject({
  title: z.string().trim().min(1).max(120).optional(),
  summary: text(2000).optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  leadId: z.string().uuid().nullable().optional(),
});
export const noteSchema = z.string().trim().min(1).max(4000);

