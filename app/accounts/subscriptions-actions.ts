"use server";

import { createSupabaseBillStore, type BillRecord, type RenewalSuggestion, type UpcomingBill } from "@/lib/finance/bills";
import { requireOwner } from "@/lib/web/api";
import { zonedYmd } from "@/lib/finance/dates";

export type SubscriptionsData = { bills: BillRecord[]; upcoming: UpcomingBill[]; suggestions: RenewalSuggestion[]; currency: string; today: string };
export type SubscriptionBillsData = { bills: BillRecord[]; currency: string; today: string };
export type SubscriptionsResult = { ok: true; ownerId: string; data: SubscriptionBillsData } | { ok: false; text: string };

/** Optional bill facts only. Reporting uses the hydrated accounting state already shown in Accounts. */
export async function loadAccountSubscriptions(): Promise<SubscriptionsResult> {
  try {
    const owner = await requireOwner();
    if (owner instanceof Response) return { ok: false, text: owner.status === 401 ? "Sign in again to load your subscriptions." : "Your subscriptions could not be loaded. Try again shortly." };
    const bills = await createSupabaseBillStore(owner.settings.supabase).list(owner.profile.profileId);
    return { ok: true, ownerId: owner.profile.profileId, data: { bills, currency: owner.profile.currency, today: zonedYmd(new Date(), owner.profile.timezone) } };
  } catch {
    return { ok: false, text: "Your subscriptions could not be loaded. Try again shortly." };
  }
}
