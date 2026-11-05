import { mkdir, writeFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import path from "node:path";

import { getDatabaseSettings } from "@/lib/env";
import { findIncidents, type Incident, type ReviewCorrection, type ReviewMessage, type ReviewPending, type ReviewTrace } from "@/lib/learning/review";
import { query } from "@/lib/supabase/connection";

/**
 * Finds conversations from the last day that went wrong and writes a report
 * plus a draft eval case for each to evals/drafts/, which git ignores: the
 * drafts hold real messages and amounts, so they never go in the public repo.
 * A committed case is rewritten with fictional names and figures first.
 * Read-only: it only runs selects. Run: npm run review:failures
 *   REVIEW_HOURS=24  how far back to look
 */

try {
  loadEnvFile();
} catch {
  // The scheduled session has .env; nothing else needs it.
}

const HOURS = Math.max(1, Number(process.env.REVIEW_HOURS ?? 24));

async function main(): Promise<void> {
  const settings = getDatabaseSettings();
  const now = new Date();
  const since = new Date(now.getTime() - HOURS * 3_600_000);
  // A little earlier than the window, so each incident has the conversation that led up to it.
  const from = new Date(since.getTime() - 6 * 3_600_000).toISOString();
  const [messages, traces, corrections, pending, people] = await Promise.all([
    query<{ owner_id: string; role: "user" | "assistant"; body: string; intent: string | null; created_at: Date; bank: string | null }>(settings,
      `select owner_id::text, role, body, intent, created_at, meta->'paymentNotice'->>'bankMessageId' as bank
       from public.messages where created_at >= $1 order by created_at`, [from]),
    query<{ owner_id: string; refused: boolean; actions: string[]; created_at: Date }>(settings,
      "select owner_id::text, refused, actions, created_at from public.turn_traces where created_at >= $1", [since.toISOString()]),
    query<{ owner_id: string; kind: string; bank_message_id: string | null; created_at: Date }>(settings,
      "select owner_id::text, kind, bank_message_id::text, created_at from public.corrections where created_at >= $1", [since.toISOString()]),
    query<{ user_id: string; action_type: string; status: string; created_at: Date; expires_at: Date }>(settings,
      "select user_id, action_type, status, created_at, expires_at from public.pending_actions where expires_at >= $1 and expires_at <= $2", [since.toISOString(), now.toISOString()]),
    query<{ id: string; preferred_name: string | null }>(settings, "select id::text, preferred_name from public.profiles"),
  ]);
  const incidents = findIncidents({
    since, now,
    messages: messages.map((row): ReviewMessage => ({ ownerId: row.owner_id, role: row.role, body: row.body, intent: row.intent, createdAt: row.created_at.toISOString(), bankMessageId: row.bank })),
    traces: traces.map((row): ReviewTrace => ({ ownerId: row.owner_id, refused: row.refused, actions: row.actions, createdAt: row.created_at.toISOString() })),
    corrections: corrections.map((row): ReviewCorrection => ({ ownerId: row.owner_id, kind: row.kind, bankMessageId: row.bank_message_id, createdAt: row.created_at.toISOString() })),
    pending: pending.map((row): ReviewPending => ({ ownerId: row.user_id, actionType: row.action_type, status: row.status, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString() })),
  });
  const name = new Map(people.map((row) => [row.id, row.preferred_name || "someone"]));
  const directory = path.join(process.cwd(), "evals", "drafts", now.toISOString().slice(0, 10));
  await mkdir(directory, { recursive: true });

  const lines = [`# Alfred failure review: last ${HOURS} hours to ${now.toISOString().slice(0, 16)}Z`, "", `${incidents.length} incident${incidents.length === 1 ? "" : "s"} across ${traces.length} chat turns.`, ""];
  for (const [index, incident] of incidents.entries()) {
    const file = `incident-${index + 1}.json`;
    await writeFile(path.join(directory, file), `${JSON.stringify(await draftCase(settings, incident, index + 1, name.get(incident.ownerId) ?? "someone"), null, 2)}\n`);
    lines.push(`## ${index + 1}. ${name.get(incident.ownerId) ?? "someone"} · ${incident.at.slice(0, 16)}Z · ${incident.kind}${incident.count > 1 ? ` ×${incident.count}` : ""}`, "", incident.what, "",
      ...incident.messages.map((message) => `- **${message.role === "user" ? "them" : "Alfred"}:** ${message.body.replace(/\s+/g, " ").slice(0, 300)}`), "", `Draft case: \`${file}\``, "");
  }
  await writeFile(path.join(directory, "report.md"), `${lines.join("\n")}\n`);
  console.log(`${incidents.length} incident${incidents.length === 1 ? "" : "s"} in the last ${HOURS} hours (${traces.length} chat turns).`);
  for (const [index, incident] of incidents.entries()) console.log(`  ${index + 1}. ${name.get(incident.ownerId) ?? "someone"} ${incident.at.slice(0, 16)}Z ${incident.kind}${incident.count > 1 ? ` ×${incident.count}` : ""}: ${incident.what}`);
  console.log(`Report and drafts: ${path.relative(process.cwd(), directory)}/`);
}

/**
 * The incident as an eval case to finish by hand: the books and conversation
 * as they were, with `final` left for whoever decides what Alfred should have
 * done. Real values: keep it in drafts until it's rewritten with fictional ones.
 */
async function draftCase(settings: ReturnType<typeof getDatabaseSettings>, incident: Incident, number: number, person: string) {
  const at = incident.at;
  const payments = await query<{ id: string; direction: "in" | "out"; amount: string; counterparty: string; occurred_at: Date; source: string; status: string }>(settings,
    `select id::text, direction, amount::text, counterparty, occurred_at, source, status from public.bank_messages
     where owner_id = $1::uuid and (id = any($2::uuid[]) or amount = any($4::numeric[])
       or (status = 'needs_label' and occurred_at between $3::timestamptz - interval '3 days' and $3::timestamptz))
     order by (id = any($2::uuid[]) or amount = any($4::numeric[])) desc, occurred_at desc limit 6`, [incident.ownerId, incident.bankMessageIds, at, mentionedAmounts(incident)]);
  const firstUser = incident.messages.findIndex((message) => message.role === "user");
  const before = firstUser === -1 ? incident.messages : incident.messages.slice(0, firstUser);
  const after = firstUser === -1 ? [] : incident.messages.slice(firstUser);
  return {
    id: `draft-${number}`,
    title: `TODO: ${incident.what}`,
    source: `${person}, ${at.slice(0, 16)}Z (${incident.kind})`,
    tags: ["draft", "real-failure"],
    now: at,
    name: person,
    setup: {
      payments: payments.map((row, index) => ({ ref: `p${index + 1}`, direction: row.direction, amount: Number(row.amount).toFixed(2), counterparty: row.counterparty, occurredAt: row.occurred_at.toISOString(), source: ["momo", "gcb", "absa", "hubtel"].includes(row.source) ? row.source : "gcb", ...(row.status !== "needs_label" ? { note: `was ${row.status} at the time` } : {}) })),
      messages: before.map((message) => ({ role: message.role, body: message.body })),
    },
    steps: after.filter((message) => message.role === "user").map((message) => ({ say: message.body })),
    alfredSaid: after.filter((message) => message.role === "assistant").map((message) => message.body),
    final: "TODO: what should have been saved",
  };
}

/** Amounts said in the conversation, like "GH₵1,300.00" or "the 350", so the payments it's about come along. */
function mentionedAmounts(incident: Incident): string[] {
  const found = incident.messages.flatMap((message) => message.body.match(/\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{2}|\b\d{3,6}\b/g) ?? []);
  return [...new Set(found.map((value) => Number(value.replace(/,/g, "")).toFixed(2)))].filter((value) => Number(value) > 0).slice(0, 12);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
