import { createHash } from "node:crypto";

import type { SupabaseSettings } from "@/lib/config";
import { applyAccountingAction } from "@/lib/finance/accounting/reducer";
import { AccountingError, needsAttention, type AccountingAction, type AccountingState, type CashMovement, type MovementReference } from "@/lib/finance/accounting/types";
import { normalizeCategory } from "@/lib/finance/categories";
import { formatDisplayDate } from "@/lib/finance/dates";
import { formatMinor } from "@/lib/finance/money";
import type { CategoryRecord } from "@/lib/finance/types";

/**
 * Sorting the Accounts page's Needs attention list in chat. Imported history
 * and card holds aren't bank texts, so they never reach the payment
 * questions; here they're asked about a merchant at a time, biggest group
 * first, and one answer files the whole group as one change with one undo.
 */

export type SortGroup = {
  /** Short stable id for the group, kept in the question's intent. */
  id: string;
  description: string;
  direction: CashMovement["direction"];
  /** Card holds are asked whether they went through; the rest what they were. */
  holds: boolean;
  count: number;
  totalMinor: number;
  currency: string;
  from: string;
  to: string;
  account: string | null;
  movements: MovementReference[];
  /** The books' revision this group was read at; filing fails safely if they changed since. */
  revision: number;
};

/** What one answer does to a whole group. */
export type SortOutcome = { status: "confirmed"; category: string } | { status: "excluded" | "duplicate" };

export type MovementSorter = {
  groups(ownerId: string): Promise<SortGroup[]>;
  /** Files every movement in the group as it was read; returns the groups still waiting after. */
  file(ownerId: string, group: SortGroup, outcome: SortOutcome, requestId: string): Promise<SortGroup[]>;
};

/** Alfred's question about a group, recognised from its words when a confirmation's reply carries no intent. */
export const SORT_QUESTION = /\b(?:What were these\?|Did these go through\?|What was this money\?)/;
/** Moving past a group without answering it. */
export const SKIP_GROUP = /^(?:skip(?: (?:it|this|that|this one|that one))?|next(?: one)?|pass|not sure|no idea|dunno|i don'?t know|later|move on)[.!]*$/i;

/** The intent stored with Alfred's question about a group. */
export const SORT_INTENT = "sort:ask";
export const sortIntent = (group: SortGroup) => `${SORT_INTENT}:${group.id}`;
export const askedGroupId = (intent: string | null | undefined) => intent?.startsWith(`${SORT_INTENT}:`) ? intent.slice(SORT_INTENT.length + 1) : null;

/** The Needs attention rows, grouped the way the Accounts page groups them, biggest first. */
export function sortGroups(state: AccountingState): SortGroup[] {
  const linked = new Set([
    ...state.transfers.flatMap((transfer) => [transfer.outgoing.movementId, transfer.incoming.movementId]),
    ...state.settlements.flatMap((settlement) => [settlement.original.movementId, ...settlement.returns.map((item) => item.movementId)]),
  ]);
  // Rows with no account need one picked on the Accounts page first; linked or legacy rows are reviewed there too.
  const rows = state.movements.filter((row) => needsAttention(row) && row.accountId && !linked.has(row.id) && !row.legacyClassification && row.direction !== "internal");
  const byKey = new Map<string, CashMovement[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.description, row.accountId, row.currency, row.direction, row.status === "hold"]);
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }
  return [...byKey].map(([key, items]) => {
    const dates = items.map((item) => item.date).sort();
    return {
      id: createHash("sha256").update(key).digest("hex").slice(0, 10),
      description: items[0].description,
      direction: items[0].direction,
      holds: items[0].status === "hold",
      count: items.length,
      totalMinor: items.reduce((sum, item) => sum + item.amountMinor, 0),
      currency: items[0].currency,
      from: dates[0],
      to: dates.at(-1)!,
      account: state.accounts.find((account) => account.id === items[0].accountId)?.label ?? null,
      movements: items.map((item) => ({ movementId: item.id, sourceFingerprint: item.sourceFingerprint })),
      revision: state.revision,
    };
  }).sort((left, right) => right.count - left.count || right.totalMinor - left.totalMinor || left.id.localeCompare(right.id));
}

/** One group in a line, for the question and for the model's list. */
export function describeGroup(group: SortGroup): string {
  const what = group.count === 1 ? "1 payment" : `${group.count} payments`;
  const way = group.direction === "in" ? "in from" : group.holds ? "held on your card for" : "out to";
  const when = group.from === group.to ? `on ${formatDisplayDate(group.from)}` : `${formatDisplayDate(group.from)} to ${formatDisplayDate(group.to)}`;
  return `${what} ${way} “${group.description}”${group.account ? ` on ${group.account}` : ""}, ${formatMinor(group.totalMinor, group.currency)} in all, ${when}`;
}

/** Alfred's question about a group, naming the answers that file it. */
export function groupQuestion(group: SortGroup, left: number): string {
  const ask = group.holds
    ? "Did these go through? Tell me what they were for (\"subscriptions\"), or say they were cancelled or never charged."
    : group.direction === "in"
      ? "What was this money? Income like salary or a gift, or your own money moving between your accounts?"
      : "What were these? A category like food or subscriptions, paying someone, or your own money moving between your accounts?";
  const more = left > 1 ? ` (${left - 1} more ${left - 1 === 1 ? "group" : "groups"} after this; say skip to move on.)` : "";
  return `${describeGroup(group)}. ${ask}${more}`;
}

/** The group to ask about after `currentId`: the next one in order, or the first. */
export function nextGroup(groups: SortGroup[], currentId: string | null, before: SortGroup[] = groups): SortGroup | null {
  if (!groups.length) return null;
  const at = currentId ? before.findIndex((group) => group.id === currentId) : -1;
  // The first group after the current one that is still waiting, in the order the person has been seeing.
  for (const candidate of before.slice(at + 1)) {
    const found = groups.find((group) => group.id === candidate.id);
    if (found) return found;
  }
  return groups.find((group) => group.id !== currentId) ?? groups[0];
}

const OWN_MONEY = /\b(?:own money|my own|myself|me to me|between (?:my|the) accounts?|(?:my|own) (?:account|wallet|momo|card|savings)|top[- ]?ups?|topped up|moving money|moved money|transfers? (?:to|from|between) (?:me|my)|withdrawals? (?:to|from) my)\b/i;
const NOT_CHARGED = /\b(?:cancel(?:l?ed)?|released|reversed|refunded|never (?:charged|went through|happened)|didn'?t go through|did not go through|declined|failed)\b/i;
const DUPLICATE = /\b(?:duplicates?|twice|double(?:d)?|same (?:one|payment) again)\b/i;

/**
 * Whether the person's own words say this outcome. When they don't, the
 * model inferred it, and Alfred shows its reading for a yes first.
 */
export function groundedOutcome(text: string, group: SortGroup, outcome: SortOutcome, categories: readonly CategoryRecord[]): boolean {
  if (outcome.status !== "confirmed") return outcome.status === "duplicate" ? DUPLICATE.test(text) : OWN_MONEY.test(text) || NOT_CHARGED.test(text);
  const { category } = outcome;
  const type = group.direction === "in" ? "income" : "expense";
  const pairs = text.toLowerCase().match(/[\p{L}&]+(?:\s+[\p{L}&]+)?/gu) ?? [];
  const singles = text.toLowerCase().match(/[\p{L}&]+/gu) ?? [];
  return [...singles, ...pairs, text.trim().replace(/[.!]+$/, "")].some((word) => normalizeCategory(word, type, categories) === category);
}

/** The outcome in words, for "Filed …" and for the confirmation. */
export function outcomeWords(outcome: SortOutcome, group: SortGroup): string {
  if (outcome.status === "confirmed") return `under ${outcome.category}`;
  if (outcome.status === "duplicate") return "as duplicates, so they don't count twice";
  return group.holds ? "as never charged, so they don't count" : "as your own money moving, so they don't count as spending or income";
}

/**
 * Files one group, says what changed, and asks about the next group in the
 * same message. `before` is the list the person was shown, when the turn
 * already read it, so the books are only read again by the save itself.
 */
export async function fileAndAskNext(sorter: MovementSorter, ownerId: string, before: SortGroup[] | null, groupId: string, outcome: SortOutcome, requestId: string): Promise<{ text: string; next: SortGroup | null }> {
  const shown = before ?? await sorter.groups(ownerId);
  const group = shown.find((item) => item.id === groupId);
  if (!group) return { text: "Those payments were already sorted or changed since I asked. Nothing was changed.", next: null };
  let after: SortGroup[];
  try {
    after = await sorter.file(ownerId, group, outcome, requestId);
  } catch (error) {
    if (error instanceof AccountingError && (error.code === "stale" || error.code === "conflict" || error.code === "not_found")) {
      return { text: "Those payments changed since I asked, so I haven't filed them. Say carry on and I'll show them as they are now.", next: null };
    }
    throw error;
  }
  const done = `Filed ${group.count === 1 ? "that payment" : `those ${group.count} payments`} ${outcomeWords(outcome, group)}.`;
  const next = nextGroup(after, groupId, shown);
  return { text: next ? `${done}\n\nNext: ${groupQuestion(next, after.length)}` : `${done} That's everything on the Needs attention list sorted.`, next };
}

const classify = (group: SortGroup, outcome: SortOutcome, requestId: string): AccountingAction =>
  ({ type: "classify_movements", movements: group.movements, ...outcome, expectedRevision: group.revision, requestId });

/** Books and filing straight from the accounting state, for tests and evals. */
export class MemorySorter implements MovementSorter {
  constructor(public state: AccountingState) {}
  async groups(ownerId: string) { return ownerId === this.state.ownerId ? sortGroups(this.state) : []; }
  async file(ownerId: string, group: SortGroup, outcome: SortOutcome, requestId: string) {
    if (ownerId !== this.state.ownerId) throw new AccountingError("Financial state belongs to another owner.", "ownership");
    this.state = applyAccountingAction(this.state, classify(group, outcome, requestId));
    return sortGroups(this.state);
  }
}

/** The person's real books: the same state the Accounts page reads and writes. */
export function createSupabaseSorter(settings: SupabaseSettings): MovementSorter {
  return {
    async groups(ownerId) {
      // The display read leaves out undo history, which is most of the stored state.
      const { loadAccountingReadModel } = await import("@/lib/finance/accounting/persisted-store");
      const loaded = await loadAccountingReadModel(settings, ownerId);
      return loaded.availability === "ready" ? sortGroups(loaded.state) : [];
    },
    async file(ownerId, group, outcome, requestId) {
      const { saveAccountingAction } = await import("@/lib/finance/accounting/persisted-store");
      const saved = await saveAccountingAction(settings, ownerId, classify(group, outcome, requestId));
      if (saved.availability !== "ready") throw new AccountingError("The Accounts list isn't available yet.", "not_found");
      return sortGroups(saved.state);
    },
  };
}

/** The groups for the model: the one just asked about first, numbered, then the biggest of the rest. */
export function groupLines(groups: SortGroup[], asked: SortGroup | null, limit = 8): { lines: string[]; numbered: SortGroup[] } {
  const numbered = [...(asked ? [asked] : []), ...groups.filter((group) => group.id !== asked?.id)].slice(0, limit);
  return { numbered, lines: numbered.map((group, index) => `${index + 1}. ${describeGroup(group)}`) };
}
