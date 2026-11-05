import { MemoryMessageLog } from "@/lib/accounts/messages";
import type { InterpretRequest } from "@/lib/ai/deepseek";
import type { Voice } from "@/lib/ai/voice";
import { ingestBankText } from "@/lib/bank/ingest";
import { MemoryBankStore } from "@/lib/bank/store";
import type { StudioSettings, UserProfile } from "@/lib/config";
import type { EvalCase } from "@/lib/evals/cases";
import { MemoryFinanceStore } from "@/lib/finance/memory-store";
import { MemoryLoanStore, loanBalances } from "@/lib/finance/loans";
import { canonicalizeAmount } from "@/lib/finance/money";
import type { InterpretedAction } from "@/lib/finance/schemas";
import { MemoryInvestmentStore } from "@/lib/investments/store";
import { MemoryLearningLog } from "@/lib/learning/log";
import { MemoryNotebookStore } from "@/lib/notebook/store";
import { MemoryPeopleStore } from "@/lib/people/store";
import { handleProfileTurn, type StudioDeps } from "@/lib/studio/handle";

export type Brain = {
  interpret: (request: InterpretRequest) => Promise<InterpretedAction>;
  voice: Voice | null;
};

export type StepLog = { said: string; reply: string; asksToConfirm: boolean; problems: string[] };
export type CaseResult = { id: string; title: string; tags: string[]; passed: boolean; problems: string[]; steps: StepLog[]; seconds: number };

const OWNER_ID = "00000000-0000-4000-8000-0000000e0a10";

/** One fresh, in-memory person with only this case's books. Nothing here touches a real database. */
async function world(evalCase: EvalCase, settings: StudioSettings, brain: Brain) {
  const owner = { profileId: OWNER_ID, telegramUserId: null, chatId: null, preferredName: evalCase.name, timezone: "Africa/Accra", currency: "GHS", communicationPreference: "concise", toneNote: "" } as unknown as UserProfile;
  const now = new Date(evalCase.now);
  let clock = now.getTime();
  let sequence = 0;
  let actions = 0;
  let updates = 0;
  const notebook = new MemoryNotebookStore();
  const bank = new MemoryBankStore();
  bank.notebook = notebook;
  const deps: StudioDeps = {
    settings,
    store: new MemoryFinanceStore(),
    messages: new MemoryMessageLog(),
    bank,
    loans: new MemoryLoanStore(),
    investments: new MemoryInvestmentStore(),
    people: new MemoryPeopleStore(),
    notebook,
    learning: new MemoryLearningLog(),
    interpret: brain.interpret,
    voice: brain.voice,
    now: () => new Date(clock),
    createId: () => `7a1b2c3d-6666-4666-8666-${String(++sequence).padStart(12, "0")}`,
    createActionId: () => `eval-action-${++actions}`,
    nextUpdateId: () => 700000 + ++updates,
  };
  const refs = new Map<string, string>();
  for (const text of evalCase.setup.bankTexts) {
    await ingestBankText({ bank, ledger: deps.store, now, createId: deps.createId, loans: deps.loans ?? undefined, people: deps.people, investments: deps.investments ?? null }, owner, text, { channel: "mac" });
  }
  for (const [index, payment] of evalCase.setup.payments.entries()) {
    const saved = await bank.insertMessage({
      ownerId: OWNER_ID, source: payment.source, channel: "mac", externalId: `eval-${index}`, direction: payment.direction, kind: "payment",
      amount: payment.amount, fee: "0.00", currency: "GHS", counterparty: payment.counterparty, balance: null, occurredAt: payment.occurredAt,
      status: payment.status, raw: `Synthetic eval payment ${payment.ref}`, textHash: `eval-${evalCase.id}-${index}`,
    });
    if (saved) refs.set(payment.ref, saved.id);
  }
  for (const investment of evalCase.setup.investments) {
    await deps.investments!.create(OWNER_ID, { name: investment.name, kind: investment.kind, currency: "GHS", investedBefore: investment.investedBefore });
  }
  for (const [index, budget] of evalCase.setup.budgets.entries()) {
    await deps.store.saveBudget({ budgetId: `eval-budget-${index}`, userId: OWNER_ID, period: evalCase.now.slice(0, 7), category: budget.category, amount: budget.amount, currency: "GHS", createdAt: evalCase.now, updatedAt: evalCase.now });
  }
  for (const message of evalCase.setup.messages) {
    await deps.messages!.append({ ownerId: OWNER_ID, role: message.role, channel: "web", body: message.body, intent: message.intent ?? null });
  }
  if (evalCase.setup.notice) {
    const id = refs.get(evalCase.setup.notice)!;
    const payment = evalCase.setup.payments.find((item) => item.ref === evalCase.setup.notice)!;
    await deps.messages!.append({ ownerId: OWNER_ID, role: "assistant", channel: "web", body: `GH₵${payment.amount} ${payment.direction === "in" ? "came in" : "went out"}. What was it for?`,
      clientId: `payment-notice-${id}`, intent: payment.direction === "in" ? "automation:incoming-payment" : "automation:outgoing-payment", paymentNotice: { bankMessageId: id, requiresPurpose: true } });
  }
  return { owner, deps, refs, tick: () => { clock += 60_000; } };
}

/** Everything a step could change, to tell whether it saved anything. */
async function snapshot(deps: StudioDeps): Promise<string> {
  const [transactions, loans, messages, contributions, notes] = await Promise.all([
    deps.store.listTransactions(OWNER_ID),
    deps.loans!.list(OWNER_ID),
    deps.bank!.listMessages(OWNER_ID),
    deps.investments!.contributions(OWNER_ID),
    deps.notebook!.list(OWNER_ID),
  ]);
  return JSON.stringify([
    transactions.filter((item) => item.status === "active").map((item) => [item.amount, item.category]),
    loans.map((item) => [item.person, item.kind, item.amount]),
    messages.map((item) => [item.id, item.status]),
    contributions.map((item) => [item.investmentId, item.amount]),
    notes.length,
  ]);
}

/** Plays one case with the given model and checks what was saved. */
export async function runCase(evalCase: EvalCase, settings: StudioSettings, brain: Brain): Promise<CaseResult> {
  const started = Date.now();
  const { owner, deps, refs, tick } = await world(evalCase, settings, brain);
  const steps: StepLog[] = [];
  const problems: string[] = [];
  let lastActionId: string | null = null;
  for (const [index, step] of evalCase.steps.entries()) {
    tick();
    const before = await snapshot(deps);
    const stepProblems: string[] = [];
    const clientId = `eval-${evalCase.id}-${index}`;
    const replyTo = step.replyTo ? { bankMessageId: refs.get(step.replyTo)!, requiresPurpose: true } : undefined;
    let result: Awaited<ReturnType<typeof handleProfileTurn>>;
    try {
      if (step.tap) {
        if (!lastActionId && step.ifAsked) continue;
        if (!lastActionId) {
          stepProblems.push(`tapped ${step.tap} but Alfred showed no confirmation`);
          steps.push({ said: `[${step.tap}]`, reply: "", asksToConfirm: false, problems: stepProblems });
          problems.push(...stepProblems.map((problem) => `step ${index + 1}: ${problem}`));
          continue;
        }
        result = await handleProfileTurn(owner, { decision: step.tap, actionId: lastActionId, clientId }, deps);
      } else {
        result = await handleProfileTurn(owner, { text: step.say!, clientId, ...(replyTo ? { replyToPayment: replyTo } : {}) }, deps);
      }
    } catch (error) {
      stepProblems.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
      steps.push({ said: step.say ?? `[${step.tap}]`, reply: "", asksToConfirm: false, problems: stepProblems });
      problems.push(...stepProblems.map((problem) => `step ${index + 1}: ${problem}`));
      break;
    }
    lastActionId = result.actionId ?? null;
    const asksToConfirm = Boolean(result.actionId);
    const expect = step.expect;
    if (expect.asksToConfirm !== undefined && expect.asksToConfirm !== asksToConfirm) stepProblems.push(expect.asksToConfirm ? "expected Confirm/Cancel, got none" : "asked to confirm when it shouldn't");
    if (expect.savesNothing && (await snapshot(deps)) !== before) stepProblems.push("saved something when it should have saved nothing");
    if (expect.reply && !new RegExp(expect.reply, "i").test(result.text)) stepProblems.push(`reply didn't match /${expect.reply}/`);
    if (expect.notReply && new RegExp(expect.notReply, "i").test(result.text)) stepProblems.push(`reply matched forbidden /${expect.notReply}/`);
    steps.push({ said: step.say ?? `[${step.tap}]`, reply: result.text, asksToConfirm, problems: stepProblems });
    problems.push(...stepProblems.map((problem) => `step ${index + 1}: ${problem}`));
  }
  problems.push(...(await checkFinal(evalCase, deps, refs)));
  return { id: evalCase.id, title: evalCase.title, tags: evalCase.tags, passed: problems.length === 0, problems, steps, seconds: (Date.now() - started) / 1000 };
}

async function checkFinal(evalCase: EvalCase, deps: StudioDeps, refs: Map<string, string>): Promise<string[]> {
  const problems: string[] = [];
  const final = evalCase.final;
  for (const [ref, status] of Object.entries(final.payments)) {
    const actual = (await deps.bank!.getMessage(OWNER_ID, refs.get(ref)!))?.status;
    if (actual !== status) problems.push(`payment ${ref} is ${actual}, expected ${status}`);
  }
  if (final.loans) {
    const balances = loanBalances(await deps.loans!.list(OWNER_ID));
    for (const expected of final.loans) {
      const found = balances.find((item) => item.person.toLowerCase() === expected.person.toLowerCase());
      if (!found) problems.push(`no loan with ${expected.person}`);
      else {
        if (expected.owed && canonicalizeAmount(found.owed) !== expected.owed) problems.push(`${expected.person} owes ${found.owed}, expected ${expected.owed}`);
        if (expected.owe && canonicalizeAmount(found.owe) !== expected.owe) problems.push(`you owe ${expected.person} ${found.owe}, expected ${expected.owe}`);
      }
    }
    if (final.loans.length === 0 && balances.length > 0) problems.push(`expected no loans, found ${balances.map((item) => item.person).join(", ")}`);
  }
  if (final.transactions) {
    const active = (await deps.store.listTransactions(OWNER_ID)).filter((item) => item.status === "active");
    const unmatched = [...active];
    for (const expected of final.transactions) {
      const at = unmatched.findIndex((item) => canonicalizeAmount(item.amount) === expected.amount && (!expected.type || item.type === expected.type) && (!expected.category || item.category === expected.category));
      if (at === -1) problems.push(`missing transaction ${expected.amount}${expected.category ? ` ${expected.category}` : ""}`);
      else unmatched.splice(at, 1);
    }
    if (unmatched.length > 0) problems.push(`unexpected transactions: ${unmatched.map((item) => `${item.amount} ${item.category}`).join(", ")}`);
  }
  if (final.investmentFlows) {
    const [investments, flows] = await Promise.all([deps.investments!.list(OWNER_ID), deps.investments!.contributions(OWNER_ID)]);
    const named = flows.map((flow) => ({ investment: investments.find((item) => item.id === flow.investmentId)?.name ?? "?", amount: canonicalizeAmount(flow.amount.replace(/^-/, "")) ? `${flow.amount.startsWith("-") ? "-" : ""}${canonicalizeAmount(flow.amount.replace(/^-/, ""))}` : flow.amount }));
    for (const expected of final.investmentFlows) {
      if (!named.some((flow) => flow.investment.toLowerCase() === expected.investment.toLowerCase() && flow.amount === expected.amount)) {
        problems.push(`no ${expected.amount} flow for ${expected.investment} (have ${JSON.stringify(named)})`);
      }
    }
  }
  if (final.remembers) {
    const notes = (await deps.notebook!.list(OWNER_ID)).map((item) => item.note).join("\n");
    for (const pattern of final.remembers) if (!new RegExp(pattern, "i").test(notes)) problems.push(`notebook doesn't remember /${pattern}/`);
  }
  return problems;
}

/** Pass rate overall and per tag. */
export function summarize(results: CaseResult[]) {
  const rate = (items: CaseResult[]) => (items.length ? items.filter((item) => item.passed).length / items.length : 1);
  const tags = [...new Set(results.flatMap((item) => item.tags))].sort();
  return {
    total: results.length,
    passed: results.filter((item) => item.passed).length,
    passRate: rate(results),
    byTag: Object.fromEntries(tags.map((tag) => [tag, rate(results.filter((item) => item.tags.includes(tag)))])),
  };
}
