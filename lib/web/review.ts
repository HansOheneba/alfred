import { titleCase } from "@/lib/bank/ingest";
import { payeeKey, purposeOf } from "@/lib/bank/parse";
import { classifyPayee } from "@/lib/bank/payees";
import { createSupabaseBankStore } from "@/lib/bank/store";
import type { StudioSettings, UserProfile } from "@/lib/config";
import { createSupabaseLoanStore, findPerson, loanBalances } from "@/lib/finance/loans";

/** One payment waiting for a label, as the review page shows it. */
export type ReviewItem = {
  id: string;
  direction: "in" | "out";
  amount: string;
  currency: string;
  occurredAt: string;
  /** Who it was to or from, as a person would say it. */
  who: string;
  /** Groups payments to the same payee; empty when the text names no one. */
  payeeKey: string;
  /** A named person can be lent to; a network transfer doesn't say who received it. */
  payee: "person" | "channel" | "card";
  /** The sender's note from the text's reference, like "WiFi". */
  purpose: string;
  /** What the sender still owes, when money comes in from someone who borrowed. */
  owed: string | null;
};

export async function loadReview(profile: UserProfile, settings: StudioSettings): Promise<ReviewItem[]> {
  const [held, loans] = await Promise.all([
    createSupabaseBankStore(settings.supabase).listMessages(profile.profileId, "needs_label"),
    createSupabaseLoanStore(settings.supabase).list(profile.profileId),
  ]);
  const balances = loanBalances(loans).filter((item) => Number(item.owed) > 0);
  return held
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
    .map((message) => {
      const named = message.counterparty && !/^gcb/i.test(message.counterparty) ? titleCase(message.counterparty) : "";
      const kind = classifyPayee(message.counterparty).kind;
      const debtor = message.direction === "in" && named ? findPerson(balances, named) : null;
      return {
        id: message.id,
        direction: message.direction,
        amount: message.amount,
        currency: message.currency,
        occurredAt: message.occurredAt,
        who: named || "GCB card",
        payeeKey: named ? payeeKey(message.counterparty) : "",
        payee: !named ? "card" : kind === "channel" ? "channel" : "person",
        owed: debtor ? debtor.owed : null,
        purpose: purposeOf(message),
      };
    });
}
