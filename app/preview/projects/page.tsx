import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ProjectsBoard } from "@/app/projects/projects-board";
import { automationPreviewAllowed } from "@/lib/preview/access";
import type { TeamBoard } from "@/lib/team/types";

export const metadata = { title: "Projects preview · Alfred", robots: { index: false, follow: false } };

const ME = "00000000-0000-4000-8000-000000000001", THEM = "00000000-0000-4000-8000-000000000002";
/** Fictional projects; changes here go nowhere. */
const board: TeamBoard = {
  members: [{ id: ME, name: "Ama" }, { id: THEM, name: "Kojo" }],
  projects: [
    { id: "00000000-0000-4000-8000-0000000000a1", title: "Recipe planner for the house", summary: "Plan the week's meals from what's already in the kitchen.", status: "building", priority: "high", leadId: THEM, links: [{ url: "https://example.com/recipes", label: "Reference" }], shippedAt: null, createdBy: ME, createdAt: "2026-11-02T10:00:00.000Z", updatedAt: "2026-11-05T18:30:00.000Z",
      notes: [{ id: "n1", authorId: THEM, body: "Start with a list of what's in the fridge, typed in. Photos later.", createdAt: "2026-11-04T09:00:00.000Z", editedAt: null }, { id: "n2", authorId: ME, body: "Agreed. Keep it to one page for now.\nWe can split it once it's useful.", createdAt: "2026-11-05T18:30:00.000Z", editedAt: null }] },
    { id: "00000000-0000-4000-8000-0000000000a2", title: "Football five-a-side booking", summary: "", status: "idea", priority: "medium", leadId: null, links: [], shippedAt: null, createdBy: THEM, createdAt: "2026-11-05T08:00:00.000Z", updatedAt: "2026-11-05T08:00:00.000Z", notes: [] },
    { id: "00000000-0000-4000-8000-0000000000a3", title: "Portfolio site", summary: "A simple page with our work.", status: "shipped", priority: "low", leadId: ME, links: [], shippedAt: "2026-10-28T08:00:00.000Z", createdBy: ME, createdAt: "2026-10-20T08:00:00.000Z", updatedAt: "2026-10-28T08:00:00.000Z", notes: [] },
  ],
};

export default function ProjectsPreviewPage() {
  return <Suspense fallback={<p className="p-8 text-sm text-muted">Loading…</p>}><Preview /></Suspense>;
}
async function Preview() {
  await connection();
  if (!automationPreviewAllowed(process.env)) notFound();
  return <ProjectsBoard me={ME} initial={board} />;
}
