import { createHash } from "node:crypto";
import type { ChatMessageRecord, MessageLog } from "@/lib/accounts/messages";
import { formatAmount, toMinor } from "@/lib/finance/money";
import type { TurnReply } from "@/lib/conversation/turn";
import type { TransferChatContext, TransferConversationDeps } from "./own-transfers";

type AccountChoice = TransferChatContext["accounts"][number];
type TransferWords = { kind: "yes" | "own" | "no" } | { kind: "accounts"; from: string; to: string };

/** Deliberately narrow: a model never chooses the owner or an account ID. */
export function transferWords(text: string): TransferWords | null {
  const said = text.normalize("NFKC").trim().replace(/[.!]+$/g, "").trim();
  if (/^(?:no|nope|not mine|(?:that|it|this)(?:['’]s|\s+(?:is|was))\s+not\s+(?:my\s+)?(?:own\s+money|own[- ]account\s+transfer)|no[,\s]+(?:it|that|this)\s+was\s+(?:a\s+)?(?:gift|salary|refund|loan|payment))$/i.test(said)) return { kind: "no" };
  if (!said || said.length > 280 || /[\n;?]|\b(?:not|never|isn['’]t|wasn['’]t|didn['’]t|refund|loan|salary|gift|reversal|reverse|except|but|maybe|perhaps)\b/i.test(said)) return null;
  if (/^(?:yes|yeah|yep|correct|exactly|that['’]s right|that is right)$/i.test(said)) return { kind: "yes" };
  const accounts = /^(?:(?:yes|yeah|yep|correct|exactly)[,\s]+)?(?:(?:(?:it|that|this)\s+(?:was|is)|i)\s+)?(?:(?:a\s+)?(?:transfer(?:red)?|moved|moving)(?:\s+(?:my\s+)?(?:own\s+)?money)?\s+)?from\s+(.{1,100}?)\s+to\s+(.{1,100})$/i.exec(said);
  if (accounts) return { kind: "accounts", from: accounts[1], to: accounts[2] };
  if (/^(?:i\s+)?(?:sent|transferred|moved)\s+(?:it|this|that|the\s+money|my\s+money)\s+(?:to\s+myself|between\s+my\s+(?:own\s+)?accounts)$/i.test(said)) return { kind: "own" };
  if (/^(?:(?:yes|yeah|yep|correct|exactly)[,\s]+)?(?:(?:it|that|this)(?:['’]s|\s+(?:was|is))\s+)?(?:(?:a|an)\s+)?(?:(?:my\s+)?own\s+(?:money|transfer)|own[- ]account\s+transfer|(?:a\s+)?transfer\s+between\s+my\s+(?:own\s+)?accounts|between\s+my\s+(?:own\s+)?accounts|(?:i\s+)?(?:moved|transferred)\s+(?:my\s+)?(?:own\s+)?money\s+between\s+my\s+(?:own\s+)?accounts)$/i.test(said)) return { kind: "own" };
  return null;
}

function accountText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\b(?:my|own|the|account|wallet)\b/g, " ").replace(/\s+/g, " ").trim();
}

/** Label/provider aliases are useful only when they resolve to one saved account. */
export function namedTransferAccount(text: string, accounts: AccountChoice[]): string | null {
  const wanted = accountText(text);
  if (!wanted) return null;
  const ids = new Set(accounts.filter(account => {
    const aliases = new Set([accountText(account.label), accountText(account.provider)]);
    if ([...aliases].some(alias => /^(?:mtn|momo|mtn momo|mtn mobile money|mobile money|mobilemoney)$/.test(alias))) {
      for (const alias of ["mtn", "momo", "mtn momo", "mtn mobile money", "mobile money", "mobilemoney"]) aliases.add(alias);
    }
    return aliases.has(wanted);
  }).map(account => account.id));
  return ids.size === 1 ? [...ids][0] : null;
}

function transferProof(context: TransferChatContext): string | null {
  const transfer = context.transfer;
  if (!transfer || transfer.ownerId !== context.ownerId) return null;
  return createHash("sha256").update(JSON.stringify([
    context.ownerId, context.bankMessageId, transfer.pairId, transfer.outgoingBankMessageId,
    transfer.incomingBankMessageId, transfer.fromAccount.id, transfer.toAccount.id, transfer.amount, transfer.currency,
    context.evidenceFingerprint, transfer.evidenceFingerprint,
  ])).digest("hex");
}
export const transferQuestionIntent = (context: TransferChatContext): string | null => context.status === "candidate" && transferProof(context) ? `bank:transfer-question:${transferProof(context)}` : null;
export const transferUnpairIntent = (context: TransferChatContext): string | null => context.status === "paired" && transferProof(context) ? `bank:transfer-unpair-question:${transferProof(context)}` : null;

function safeLabel(value: string): string {
  if (/https?:\/\/|www\./i.test(value)) return "account";
  return value.replace(/[\u0000-\u001f\u007f\p{Cf}]/gu, " ").replace(/[<>\[\]`]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "account";
}

function pairedText(context: TransferChatContext): string {
  const transfer = context.transfer!;
  return `That ${formatAmount(transfer.amount, transfer.currency)} moved from your ${safeLabel(transfer.fromAccount.label)} to your ${safeLabel(transfer.toAccount.label)}. I've linked the two alerts as a transfer between your own accounts, so the transferred amount is not income or spending. Any recorded fees still count separately.`;
}

function candidateText(context: TransferChatContext): string {
  const transfer = context.transfer!;
  return `I found a ${formatAmount(transfer.amount, transfer.currency)} outgoing alert from your ${safeLabel(transfer.fromAccount.label)} and an incoming alert to your ${safeLabel(transfer.toAccount.label)}. Was this money moving between your own accounts?`;
}

function validContext(context: TransferChatContext, ownerId: string, bankMessageId: string): boolean {
  if (context.ownerId !== ownerId || context.bankMessageId !== bankMessageId) return false;
  try {
    if (toMinor(context.amount) <= 0 || !/^[A-Z]{3}$/.test(context.currency)) return false;
    const transfer = context.transfer;
    return !transfer || transfer.ownerId === ownerId && transfer.currency === context.currency &&
      toMinor(transfer.amount) === toMinor(context.amount) && transfer.fromAccount.id !== transfer.toAccount.id &&
      [transfer.outgoingBankMessageId, transfer.incomingBankMessageId].includes(bankMessageId) &&
      context.accounts.some(account => account.id === transfer.fromAccount.id) && context.accounts.some(account => account.id === transfer.toAccount.id);
  } catch { return false; }
}

/** A bare yes can answer only a saved, exact current proposal, never a newly
 * discovered candidate after an earlier generic purpose question. */
async function proposedQuestionWasShown(messages: MessageLog | null | undefined, ownerId: string, context: TransferChatContext, excludeClientId?: string, unpair = false): Promise<boolean> {
  const intent = unpair ? transferUnpairIntent(context) : transferQuestionIntent(context);
  if (!messages || !intent) return false;
  const last = (await messages.listRecent(ownerId, 6)).filter(message => !excludeClientId || message.clientId !== excludeClientId).at(-1);
  return last?.role === "assistant" && last.channel === "web" && last.intent === intent &&
    last.paymentNotice?.bankMessageId === context.bankMessageId && last.paymentNotice.requiresPurpose === true;
}

export async function answerTransferConversation(input: {
  text: string; ownerId: string; focus?: ChatMessageRecord["paymentNotice"] | null;
  clientId?: string; messages?: MessageLog | null; service?: TransferConversationDeps | null;
}): Promise<TurnReply | null> {
  if (!input.focus || !input.service) return null;
  const words = transferWords(input.text);
  if (!words) return null;
  let context: TransferChatContext;
  try { context = await input.service.inspect(input.ownerId, input.focus.bankMessageId); }
  catch { return { kind: "text", text: "I couldn't check that transfer just now. Please try again; I haven't confirmed any change.", intent: "bank:transfer-unavailable", paymentNotice: { bankMessageId: input.focus.bankMessageId, requiresPurpose: false } }; }
  if (!validContext(context, input.ownerId, input.focus.bankMessageId)) return null;
  const reply = (text: string, requiresPurpose = true, intent = "bank:transfer-question"): TurnReply => ({
    kind: "text", text, intent, paymentNotice: { bankMessageId: context.bankMessageId, requiresPurpose },
  });
  if (context.status === "paired" && context.transfer) {
    if (words.kind === "yes" && await proposedQuestionWasShown(input.messages, input.ownerId, context, input.clientId, true)) {
      try {
        const result = await input.service.reject(input.ownerId, context.bankMessageId, {
          requestId: input.clientId ?? `transfer-unpair-${createHash("sha256").update(`${input.ownerId}\0${context.bankMessageId}\0${context.evidenceFingerprint}`).digest("hex")}`,
          expectedPairId: context.transfer.pairId, evidenceFingerprint: context.evidenceFingerprint,
        });
        return result.status === "unpaired"
          ? reply("I've unlinked those two alerts as an own-account transfer. The transferred amounts are back awaiting explanation, and recorded fees are unchanged. Tell me what this payment was for.", true, "bank:transfer-unpaired")
          : reply("The linked transfer changed while I was checking, or couldn't be saved. I haven't confirmed an unlink. Please check the current match again.", false, "bank:transfer-review");
      } catch { return reply("I couldn't confirm whether the unlink was saved. Refresh the conversation to check its current state before trying again.", false, "bank:transfer-unavailable"); }
    }
    if (words.kind === "no") return reply(`Should I unlink the ${formatAmount(context.transfer.amount, context.transfer.currency)} transfer from your ${safeLabel(context.transfer.fromAccount.label)} to your ${safeLabel(context.transfer.toAccount.label)} and ask what this payment was for instead?`, true, transferUnpairIntent(context)!);
    if (words.kind === "accounts") {
      const from = namedTransferAccount(words.from, context.accounts), to = namedTransferAccount(words.to, context.accounts);
      if (from !== context.transfer.fromAccount.id || to !== context.transfer.toAccount.id) return reply("Those account names do not match the linked alerts. I haven't changed anything. Tell me the exact saved account names you meant.", false, "bank:transfer-review");
    }
    return reply(pairedText(context), false, "bank:transfer-paired");
  }
  if (words.kind === "no") return context.status === "candidate"
    ? reply("Okay, I haven't linked those alerts. Tell me what this payment was for instead.", true, "bank:transfer-declined") : null;
  if (context.status === "unavailable") return words.kind === "yes" ? null
    : reply("I can't check the saved accounts and matching alerts right now. I haven't changed anything. Please try that account-to-account explanation again in a moment.");
  if (context.status === "none") return words.kind === "yes" ? null
    : reply("I haven't found a matching opposite alert to link yet. I'll keep this payment unlabelled rather than invent the other side. Tell me the exact accounts involved, or wait for the other alert.");
  let fromAccountId: string | undefined, toAccountId: string | undefined;
  if (words.kind === "accounts") {
    fromAccountId = namedTransferAccount(words.from, context.accounts) ?? undefined;
    toAccountId = namedTransferAccount(words.to, context.accounts) ?? undefined;
    if (!fromAccountId || !toAccountId || fromAccountId === toAccountId) return reply("I couldn't uniquely match those names to two different saved accounts. Tell me their exact account names; I haven't changed anything.");
  } else if (context.status === "ambiguous") {
    return reply("More than one saved account or alert could fit. Tell me which account the money left and which account received it, using their saved names.");
  }
  if (context.status === "candidate" && context.transfer && words.kind === "yes" && !await proposedQuestionWasShown(input.messages, input.ownerId, context, input.clientId)) {
    return reply(candidateText(context), true, transferQuestionIntent(context)!);
  }
  if (!context.evidenceFingerprint) return reply("I couldn't verify the current transfer evidence. Please check the conversation again before confirming.", false, "bank:transfer-unavailable");
  let result;
  try {
    result = await input.service.confirm(input.ownerId, context.bankMessageId, {
      requestId: input.clientId ?? `transfer-reply-${createHash("sha256").update(`${input.ownerId}\0${context.bankMessageId}\0${input.text}`).digest("hex")}`,
      evidenceFingerprint: context.evidenceFingerprint,
      ...(context.transfer ? { expectedPairId: context.transfer.pairId } : {}),
      ...(fromAccountId ? { fromAccountId } : {}), ...(toAccountId ? { toAccountId } : {}),
    });
  } catch { return reply("I couldn't confirm whether the transfer was saved. Refresh the conversation to check its current state before trying again.", false, "bank:transfer-unavailable"); }
  if (result.status === "paired" && result.transfer) {
    if (fromAccountId && result.transfer.fromAccount.id !== fromAccountId || toAccountId && result.transfer.toAccount.id !== toAccountId || context.transfer && result.transfer.pairId !== context.transfer.pairId) {
      return reply("The saved transfer no longer matches those accounts or alerts. Please check the current match before relying on it.");
    }
    const paired = { ...context, status: "paired" as const, transfer: result.transfer };
    return validContext(paired, input.ownerId, context.bankMessageId)
      ? reply(pairedText(paired), false, "bank:transfer-paired")
      : reply("The transfer result could not be verified. Please check again before relying on it.");
  }
  return reply(result.status === "ambiguous"
    ? "More than one matching alert could fit. Tell me the exact account names and which payment you mean; I haven't linked anything."
    : result.status === "unavailable"
      ? "I couldn't save that transfer just now. Please try again; I haven't confirmed it."
      : "The alerts or accounts changed while I was checking. I haven't linked them. Tell me which accounts this transfer used again.");
}
