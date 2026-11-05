import { z } from "zod";

/** What the team's projects look like, shared by the server and the page. No database code here. */

export const PROJECT_STATUSES = ["idea", "planned", "building", "shipped", "parked"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const PROJECT_PRIORITIES = ["high", "medium", "low"] as const;
export type ProjectPriority = (typeof PROJECT_PRIORITIES)[number];

export type TeamMember = { id: string; name: string };
export type ProjectLink = { url: string; label: string };
export type ProjectNote = { id: string; authorId: string; body: string; createdAt: string; editedAt: string | null };
export type TeamProject = {
  id: string; title: string; summary: string; status: ProjectStatus; priority: ProjectPriority;
  /** One member taking it, or null for both. */
  leadId: string | null;
  links: ProjectLink[];
  createdBy: string; createdAt: string; updatedAt: string; shippedAt: string | null;
  notes: ProjectNote[];
};
export type TeamBoard = { members: TeamMember[]; projects: TeamProject[] };

const text = (max: number) => z.string().trim().max(max);
export const linkSchema = z.strictObject({
  url: z.string().trim().max(500).url().refine((value) => /^https?:\/\//i.test(value), "Links must start with http:// or https://."),
  label: text(80).default(""),
});
const links = z.array(linkSchema).max(12);
export const newProjectSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  summary: text(2000).default(""),
  status: z.enum(PROJECT_STATUSES).default("idea"),
  priority: z.enum(PROJECT_PRIORITIES).default("medium"),
  leadId: z.string().uuid().nullable().default(null),
  links: links.default([]),
});
export const projectChangeSchema = z.strictObject({
  title: z.string().trim().min(1).max(120).optional(),
  summary: text(2000).optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  priority: z.enum(PROJECT_PRIORITIES).optional(),
  leadId: z.string().uuid().nullable().optional(),
  links: links.optional(),
});
export const noteSchema = z.string().trim().min(1).max(4000);
