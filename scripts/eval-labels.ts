import { loadEnvFile } from "node:process";

import { interpretMessage, type InterpretRequest } from "@/lib/ai/deepseek";
import { LABEL_MODEL } from "@/lib/bank/reply";
import type { FinanceAction } from "@/lib/finance/schemas";

/**
 * Replays conversations Alfred once got wrong against the real model, so a
 * prompt change can be checked before it ships. Run: npm run eval:labels
 */

try {
  loadEnvFile();
} catch {
  // .env is loaded when the file exists.
}

type Case = {
  name: string;
  request: Omit<InterpretRequest, "timezone" | "currency" | "now" | "recent">;
  /** Null when the action is right, otherwise what was wrong. */
  check: (action: FinanceAction) => string | null;
};

const MITCH_WAITING = [
  "1. OUT GH₵58.50 to Telecel Push (sent to a Telecel Cash number; the recipient isn't named) · Wed 28 Oct, 20:44",
  "2. IN GH₵1,000.00 from Mitch Ivan Abakah · Mon 26 Oct, 07:57",
];

function labelled(action: FinanceAction, kind: string, items: number[]): string | null {
  if (action.type !== "label_payments") return `expected label_payments, got ${action.type}`;
  const matching = action.answers.filter((answer) => answer.action === kind);
  if (matching.length === 0) return `expected a ${kind} label, got ${action.answers.map((answer) => answer.action).join(", ")}`;
  const picked = matching.flatMap((answer) => answer.items).sort();
  return JSON.stringify(picked) === JSON.stringify(items) ? null : `expected items ${items}, got ${picked}`;
}

const CASES: Case[] = [
  {
    name: "a loan to the user is borrowed, not repaid",
    request: {
      text: "By the way the 1000 from Mitch was a loan to me, so I owe him",
      waiting: { lines: MITCH_WAITING, current: 1 },
      model: LABEL_MODEL,
    },
    check: (action) => labelled(action, "borrowed", [2]),
  },
  {
    name: "a correction relabels what was just filed",
    request: {
      text: "No I mean he gave me a loan so now I owe him, I've not paid him yet",
      waiting: {
        lines: [MITCH_WAITING[0], "2. IN GH₵1,000.00 from Mitch Ivan Abakah · Mon 26 Oct, 07:57 · JUST FILED as paying the user back"],
        current: 1,
      },
      history: [
        { role: "user", body: "By the way the 1000 from Mitch was a loan to me, so I owe him" },
        { role: "assistant", body: "Marked GH₵1,000.00 from Mitch Ivan Abakah as paying you back. Mitch Ivan Abakah has paid you back in full." },
      ],
      model: LABEL_MODEL,
    },
    check: (action) => labelled(action, "borrowed", [2]),
  },
  {
    name: "a bare yes never deletes or corrects",
    request: {
      text: "Yep",
      history: [
        { role: "user", body: "No I mean he gave me a loan so now I owe him, I've not paid him yet" },
        {
          role: "assistant",
          body: "My mistake, Hans. So the GH₵1,000 from Mitch was money he lent you. Shall I undo that record so it stops counting as a repayment, and note that you owe Mitch GH₵1,000? Confirm or cancel.",
        },
      ],
    },
    check: (action) => (action.type === "delete_transaction" || action.type === "correct_transaction" ? `got ${action.type}` : null),
  },
  {
    name: "chat never asks to confirm a change",
    request: { text: "The 1000 from Mitch was a loan to me so I owe him, can you fix it?" },
    check: (action) => (action.type === "chat" && /confirm|shall i|should i/i.test(action.message) ? `chat offered a change: ${action.message}` : null),
  },
  {
    name: "a cash loan to the user is recorded as borrowed",
    request: { text: "I borrowed 200 cash from Kwame yesterday" },
    check: (action) => (action.type === "record_loan" && action.direction === "borrowed" ? null : `got ${action.type}${action.type === "record_loan" ? ` ${action.direction}` : ""}`),
  },
  {
    name: "who the user owes is a loans question",
    request: { text: "who do I owe money?" },
    check: (action) => (action.type === "get_loans" ? null : `got ${action.type}`),
  },
  {
    name: "a nickname only files the payment it names",
    request: {
      text: "Debra was okada home just now",
      waiting: {
        lines: ["1. OUT GH₵40.50 to Benjamin Debrah · Thu 29 Oct, 17:30", "2. OUT GH₵12.00 to Adisah Anabzo · Thu 29 Oct, 12:10"],
        current: 2,
      },
      model: LABEL_MODEL,
    },
    check: (action) => labelled(action, "category", [1]),
  },
];

const RUNS = Number(process.env.EVAL_RUNS ?? 2);

async function main(): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const model = process.env.DEEPSEEK_MODEL;
  if (!apiKey || !model) throw new Error("DeepSeek is not configured");
  let failures = 0;
  for (const item of CASES) {
    for (let run = 1; run <= RUNS; run += 1) {
      const action = await interpretMessage(
        { apiKey, model },
        { timezone: "Africa/Accra", currency: "GHS", now: new Date("2026-10-29T17:50:00.000Z"), recent: [], preferredName: "Hans", ...item.request },
      );
      const problem = item.check(action);
      if (problem) failures += 1;
      console.log(`${problem ? "FAIL" : "ok  "} ${item.name} (run ${run})${problem ? `: ${problem}` : ""}`);
    }
  }
  console.log(failures ? `${failures} failed` : "all passed");
  if (failures) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
