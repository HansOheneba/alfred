"use server";

import { createSupabaseBillStore, type BillRecord, type RenewalSuggestion, type UpcomingBill } from "@/lib/finance/bills";
import { requireOwner } from "@/lib/web/api";
import { durableDisplayEnabled, DurableDisplayUpdating } from "@/lib/finance/accounting/durable-read";
import { tryLoadDurableSubscriptions } from "@/lib/finance/accounting/durable-subscriptions";
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

/** The paged Accounts display never downloads complete accounting sources to derive renewals. */
export async function loadAccountSubscriptionsView(): Promise<{ ok: true; ownerId: string; data: SubscriptionsData } | { ok: false; text: string }> {
  try {
    const owner = await requireOwner();
    if (owner instanceof Response) return { ok: false, text: "Sign in again to load subscriptions." };
    const today = zonedYmd(new Date(), owner.profile.timezone);
    const billsPromise = createSupabaseBillStore(owner.settings.supabase).list(owner.profile.profileId);
    const readCanonical = async () => {
      const [{ loadAccountingReadModel }, { subscriptionsData }] = await Promise.all([import("@/lib/finance/accounting/persisted-store"), import("./subscriptions-data")]);
      const [accounting, bills] = await Promise.all([loadAccountingReadModel(owner.settings.supabase, owner.profile.profileId), billsPromise]);
      if (accounting.state.ownerId !== owner.profile.profileId) throw new Error("Account ownership changed.");
      return subscriptionsData({ bills, currency: owner.profile.currency, today }, accounting.state);
    };
    if (durableDisplayEnabled()) {
      const bills = await billsPromise;
      const data = await tryLoadDurableSubscriptions(owner.settings.supabase, owner.profile.profileId, owner.profile.currency, today, bills);
      if (data) return { ok: true, ownerId: owner.profile.profileId, data };
    }
    return { ok: true, ownerId: owner.profile.profileId, data: await readCanonical() };
  } catch (error) { return { ok: false, text: error instanceof DurableDisplayUpdating ? error.message : "Your subscriptions could not be loaded. Try again shortly." }; }
}
