import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { AppShell } from "@/app/components/app-shell";
import { MissingAuthConfig, publicAuthConfigured, signedInAccount } from "@/app/signed-in";
import { createSupabaseTeamStore } from "@/lib/team/store";
import { ProjectsBoard } from "./projects-board";

export const metadata: Metadata = { title: "Projects · Alfred", robots: { index: false, follow: false } };

export default function ProjectsPage() {
  if (!publicAuthConfigured()) return <MissingAuthConfig />;
  return <Suspense fallback={<AppShell current="projects" name=""><p className="mx-auto max-w-4xl px-4 py-8 text-sm text-muted">Loading projects…</p></AppShell>}><ProjectsContent /></Suspense>;
}

/** Only team members ever see this page; to anyone else it doesn't exist. */
async function ProjectsContent() {
  const account = await signedInAccount();
  if (account.kind === "signed-out") redirect("/");
  if (account.kind === "error") notFound();
  const board = await createSupabaseTeamStore(account.settings.supabase).board(account.profile.profileId);
  if (!board) notFound();
  return (
    <AppShell current="projects" ownerId={account.userId} name={account.profile.preferredName.trim()}>
      <ProjectsBoard me={account.profile.profileId} initial={board} />
    </AppShell>
  );
}
