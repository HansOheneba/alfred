import { loadEnvFile } from "node:process";

import { interpretMessage, type InterpretRequest } from "@/lib/ai/deepseek";
import { LABEL_MODEL } from "@/lib/bank/reply";
import { actionsOf, type FinanceAction } from "@/lib/finance/schemas";

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
  /** Null when the action is right, otherwise what was wrong. Several actions are checked as their first relevant one. */
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
  {
    name: "not looking at Mum's account ignores it for good",
    request: {
      text: "That's a fee but ignore the bank that has these details\n\nHi Hans Oheneba Aduse\nYour A/C No:XXXX0543\nhas been debited GHS12.00\nDesc: ESERVICE BUNDLE CHARGE\nDate: 2026-10-30 22:55\nBal: GHS 50,085.00\n\nThis money is more than I have it's just an account I'm managing for her it's my mums",
      waiting: {
        lines: [
          "1. OUT GH₵31.00 to Abubakar Sadik Ibrahim · Fri 30 Oct, 17:44",
          "2. OUT GH₵12.00 to GCB card · Fri 30 Oct, 22:55 · account ending 0543",
        ],
        current: 2,
      },
      model: LABEL_MODEL,
    },
    check: (action) => (action.type === "ignore_account" && action.account.endsWith("0543") ? null : `got ${action.type}${action.type === "ignore_account" ? ` ${action.account}` : ""}`),
  },
  {
    name: "yes to a card hold going through counts it once",
    request: {
      text: "yeah that's the spotify one",
      waiting: {
        lines: [
          "1. OUT GH₵33.00 to Absa account (no payee named) · Tue 13 Oct, 09:10 · account ending 4821 · may be the Spotify card payment that was on hold and is already counted; if the user says it's the same payment, use skip",
          "2. OUT GH₵100.00 to Kofi Mensah Addo · Sun 11 Oct, 18:33 · account ending 4821",
        ],
        current: 1,
      },
      model: LABEL_MODEL,
    },
    check: (action) => labelled(action, "skip", [1]),
  },
  {
    name: "no to a card hold files the debit as what it was",
    request: {
      text: "no that one was lunch",
      waiting: {
        lines: [
          "1. OUT GH₵33.00 to Absa account (no payee named) · Tue 13 Oct, 09:10 · account ending 4821 · may be the Spotify card payment that was on hold and is already counted; if the user says it's the same payment, use skip",
        ],
        current: 1,
      },
      model: LABEL_MODEL,
    },
    check: (action) => labelled(action, "category", [1]),
  },
  {
    name: "a new US investment account is added with its holdings",
    request: { text: "I have a Risevest account with 2 shares of VOO and half a share of Microsoft" },
    check: (action) => {
      if (action.type !== "add_investment") return `got ${action.type}`;
      if (action.kind !== "us_stocks") return `kind ${action.kind}`;
      const symbols = (action.holdings ?? []).map((item) => item.symbol).sort().join(",");
      return symbols === "MSFT,VOO" ? null : `holdings ${symbols}`;
    },
  },
  {
    name: "a T-bill is added with its rate and maturity",
    request: { text: "I just bought a 91-day treasury bill of 5000 cedis at 24%" },
    check: (action) => {
      if (action.type !== "add_investment") return `got ${action.type}`;
      if (action.kind !== "tbill") return `kind ${action.kind}`;
      if (action.principal !== "5000.00" || action.rate !== 24) return `principal ${action.principal} rate ${action.rate}`;
      return action.matures_on ? null : "no maturity date";
    },
  },
  {
    name: "a new value for an investment the user has is an update",
    request: { text: "my databank fund is at 8,400 now", investments: ["Databank Epack (Mutual fund, GHS)", "Risevest (US stocks, USD)"] },
    check: (action) => (action.type === "update_investment" && action.value === "8400.00" && /databank/i.test(action.name) ? null : `got ${action.type}`),
  },
  {
    name: "money put into an investment outside the bank texts",
    request: { text: "I put 500 into my T-bill today", investments: ["91-day T-bill (Treasury bill, GHS, matures 2027-01-02)"] },
    check: (action) => (action.type === "invest_money" && action.direction === "in" && action.amount === "500.00" ? null : `got ${action.type}`),
  },
  {
    name: "net worth asks for investments with cash",
    request: { text: "what's my net worth?", investments: ["Risevest (US stocks, USD)"] },
    check: (action) => (action.type === "get_investments" && action.net_worth === true ? null : `got ${action.type}`),
  },
  {
    name: "how investments are doing is get_investments",
    request: { text: "how are my investments doing?", investments: ["Risevest (US stocks, USD)"] },
    check: (action) => (action.type === "get_investments" ? null : `got ${action.type}`),
  },
  {
    name: "a waiting payment to an investment app is labelled as an investment",
    request: {
      text: "the 1130 to risevest was me investing",
      waiting: { lines: ["1. OUT GH₵1,130.00 to Risevest Technologies · Sun 25 Oct, 10:12", "2. OUT GH₵40.00 to Benjamin Debrah · Sat 24 Oct, 17:30"], current: 2 },
      investments: ["Risevest (US stocks, USD)"],
      model: LABEL_MODEL,
    },
    check: (action) => labelled(action, "investment", [1]),
  },
  {
    name: "what's left asks for the overview with balances",
    request: { text: "Okay what's left in my finances" },
    check: (action) => (action.type === "get_financial_overview" ? null : `got ${action.type}`),
  },
  {
    name: "a standing fact about the user goes in the notebook",
    request: { text: "Remember that I get paid on the 25th every month" },
    check: (action) => (action.type === "remember_about_me" ? null : `got ${action.type}`),
  },
  {
    name: "a payment for next month counts in that month",
    request: {
      text: "the 500 to Annette was my house contribution for November",
      waiting: { lines: ["1. OUT GH₵500.00 to Annette Akushika Kwashie · Fri 30 Oct, 17:58"], current: 1 },
      model: LABEL_MODEL,
    },
    check: (action) => {
      if (action.type !== "label_payments") return `got ${action.type}`;
      const answer = action.answers[0];
      if (answer.category !== "Rent & home") return `filed under ${answer.category}`;
      return answer.for_month === "2026-11" || /november/i.test(answer.description ?? "") ? null : "not counted in November";
    },
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
      // With several actions, the case passes if any one of them is right.
      const problems = actionsOf(action).map((one) => item.check(one));
      const problem = problems.includes(null) ? null : problems.join(" | ");
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
