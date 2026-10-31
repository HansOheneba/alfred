import { loadEnvFile } from "node:process";

import { MemoryMessageLog } from "@/lib/accounts/messages";
import { interpretMessage } from "@/lib/ai/deepseek";
import { createVoice } from "@/lib/ai/voice";
import { bankAccess, ingestBankText, type IngestDeps } from "@/lib/bank/ingest";
import { MemoryBankStore } from "@/lib/bank/store";
import { converse, type TurnDeps } from "@/lib/conversation/turn";
import type { ActionContext } from "@/lib/finance/action-router";
import { MemoryLoanStore } from "@/lib/finance/loans";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { MemoryNotebookStore } from "@/lib/notebook/store";
import { MemoryPeopleStore } from "@/lib/people/store";

/**
 * Plays whole conversations through Alfred, with the real model and voice and
 * in-memory books, and checks each reply. These are the conversations that
 * went wrong before, plus what a friend trying Alfred for the first time
 * would say. Run: npm run eval:conversations
 */

try {
  loadEnvFile();
} catch {
  // .env is loaded when the file exists.
}

type World = { bank: MemoryBankStore; store: MemoryFinanceStore; loans: MemoryLoanStore; notebook: MemoryNotebookStore; messages: MemoryMessageLog; ingest: IngestDeps };
type Step = { say: string; expect: RegExp; not?: RegExp };
type Script = { name: string; setup?: (world: World) => Promise<void>; steps: Step[] };

const NOW = new Date("2026-10-31T05:15:00.000Z");
const ELLEN =
  "Payment made for GHS 22.50 to ELLEN OHENEWA OBENG-DARKO Current Balance: GHS 1512.11 . Available Balance: GHS 1512.11. Reference: . Transaction ID: 92694674830. Fee charged: GHS0.00";
const MITCH =
  "Payment received for GHS 1,000.00 from MITCH IVAN ABAKAH Current Balance: GHS 1,210.00 . Available Balance: GHS 1,210.00. Reference: . Transaction ID: 92400000030. TRANSACTION FEE: 0.00";
const MUM = "Hi Hans Oheneba Aduse Your A/C No:XXXX0543 has been debited GHS12.00 Desc: ESERVICE BUNDLE CHARGE Date: 2026-10-30 22:55 Bal: GHS 50,085.00";

async function held(world: World, text: string) {
  await ingestBankText(world.ingest, OWNER, text, { channel: "mac" });
}
async function alfredSaid(world: World, body: string) {
  await world.messages.append({ ownerId: OWNER.profileId, role: "assistant", body, channel: "telegram", intent: "bank:notice" });
}

const SCRIPTS: Script[] = [
  {
    name: "asking after promising to ask later",
    setup: async (world) => {
      await held(world, ELLEN);
      await alfredSaid(world, "I'll ask about the one that needs a label in the morning.");
    },
    steps: [
      { say: "go on then", expect: /Ellen Ohenewa Obeng-Darko/, not: /quiet|all ears/i },
      { say: "malt", expect: /Filed GH₵22\.50 under Food/ },
    ],
  },
  {
    name: "a loan to me, then changing my mind",
    setup: async (world) => held(world, MITCH),
    steps: [
      { say: "the 1000 from Mitch was a loan to me, I owe him", expect: /lent you GH₵1,000\.00/ },
      { say: "actually no, sorry, it was a gift from him", expect: /Fixed\./ },
    ],
  },
  {
    name: "yes in my own words to a confirmation",
    steps: [
      { say: "I borrowed 200 cash from Kwame yesterday", expect: /Kwame lent you GH₵200\.00/ },
      { say: "yeah go ahead", expect: /You owe Kwame GH₵200\.00/ },
      { say: "who do I owe?", expect: /Kwame/, not: /^No one owes you/ },
    ],
  },
  {
    name: "two things in one message",
    setup: async (world) => held(world, MUM),
    steps: [{ say: "that's my mum's account, ignore it. also remember I get paid on the 25th", expect: /account ending 0543[\s\S]*25th|25th[\s\S]*account ending 0543/ }],
  },
  {
    name: "a friend's first time",
    setup: async (world) => {
      world.bank.messages = [];
    },
    steps: [
      { say: "hi", expect: /connect your texts/ },
      { say: "what can you do?", expect: /\S/, not: /couldn't|error|went wrong/i },
      { say: "I spent 40 on lunch today", expect: /40/ },
    ],
  },
  {
    name: "answering a clarifying question",
    steps: [
      { say: "I spent 50 today", expect: /\?/ },
      { say: "on transport", expect: /50/ },
    ],
  },
  {
    name: "small talk while payments wait",
    setup: async (world) => {
      await held(world, ELLEN);
      await world.messages.append({ ownerId: OWNER.profileId, role: "assistant", body: "Filed GH₵20.00 under Food.", channel: "telegram", intent: "create_transaction" });
    },
    steps: [{ say: "how are things?", expect: /\S/, not: /books are quiet|nothing (?:is )?(?:waiting|pending)|all caught up/i }],
  },
];

const OWNER = {
  profileId: "eval-owner",
  preferredName: "Hans",
  currency: "GHS",
  timezone: "Africa/Accra",
  communicationPreference: "concise" as const,
  toneNote: "",
} as unknown as ActionContext["profile"];

const RUNS = Number(process.env.EVAL_RUNS ?? 1);

async function play(script: Script, settings: { apiKey: string; model: string }): Promise<string[]> {
  const bank = new MemoryBankStore();
  const notebook = new MemoryNotebookStore();
  bank.notebook = notebook;
  const store = new MemoryFinanceStore();
  const loans = new MemoryLoanStore();
  const messages = new MemoryMessageLog();
  let sequence = 0;
  const createId = () => `7a1b2c3d-5555-4555-8555-${String(++sequence).padStart(12, "0")}`;
  const world: World = { bank, store, loans, notebook, messages, ingest: { bank, ledger: store, now: NOW, createId, loans } };
  await script.setup?.(world);
  const deps: TurnDeps = {
    store,
    bank,
    loans,
    notebook,
    messages,
    people: new MemoryPeopleStore(),
    createId,
    interpret: (request) => interpretMessage(settings, request),
    voice: createVoice(settings),
  };
  const failures: string[] = [];
  let actions = 0;
  for (const [index, step] of script.steps.entries()) {
    const ctx: ActionContext = {
      profile: OWNER,
      store,
      now: new Date(NOW.getTime() + index * 60_000),
      updateId: 1000 + index,
      chatId: 100,
      confirmTransactions: "auto",
      pendingTtlMs: 600_000,
      createId,
      createActionId: () => `evalaction${String(++actions).padStart(2, "0")}`,
      loans,
      notebook,
      bank: bankAccess(bank, notebook, OWNER.profileId),
    };
    const reply = await converse(step.say, ctx, deps, { channel: "telegram" });
    await messages.append({ ownerId: OWNER.profileId, role: "user", body: step.say, channel: "telegram" });
    await messages.append({ ownerId: OWNER.profileId, role: "assistant", body: reply.text, channel: "telegram", intent: reply.intent ?? null });
    const ok = step.expect.test(reply.text) && !(step.not && step.not.test(reply.text));
    console.log(`  ${ok ? "ok  " : "FAIL"} you: ${step.say}\n       alfred: ${reply.text.replace(/\s+/g, " ").slice(0, 220)}`);
    if (!ok) failures.push(`${script.name}: "${step.say}"`);
  }
  return failures;
}

async function main(): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const model = process.env.DEEPSEEK_MODEL;
  if (!apiKey || !model) throw new Error("DeepSeek is not configured");
  const failures: string[] = [];
  for (const script of SCRIPTS) {
    for (let run = 1; run <= RUNS; run += 1) {
      console.log(`${script.name}${RUNS > 1 ? ` (run ${run})` : ""}`);
      failures.push(...(await play(script, { apiKey, model })));
    }
  }
  console.log(failures.length ? `\n${failures.length} failed:\n${failures.join("\n")}` : "\nall passed");
  if (failures.length) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
