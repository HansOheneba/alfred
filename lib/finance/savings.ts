import { toMinor } from "@/lib/finance/money";
import type { SavingsGoalRecord } from "@/lib/finance/types";

export function matchGoals(
  goals: SavingsGoalRecord[],
  query: { goalId?: string | null; name?: string | null },
): SavingsGoalRecord[] {
  const active = goals.filter((goal) => goal.status !== "deleted");
  if (query.goalId) {
    const exact = active.filter((goal) => goal.goalId === query.goalId);
    if (exact.length > 0) return exact;
    return active.filter((goal) => goal.goalId.startsWith(query.goalId ?? ""));
  }
  const name = query.name?.trim().toLowerCase();
  if (!name) return [];
  const exact = active.filter((goal) => goal.name.toLowerCase() === name);
  if (exact.length > 0) return exact;
  return active.filter((goal) => goal.name.toLowerCase().includes(name));
}

export function addContribution(currentAmount: string, contribution: string): string {
  const minor = toMinor(currentAmount) + toMinor(contribution);
  return `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}
