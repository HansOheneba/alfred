import type { MessageLog } from "@/lib/accounts/messages";
import { formatDisplayDate } from "@/lib/finance/dates";
import { formatMinor } from "@/lib/finance/money";
import { refreshPrices } from "@/lib/investments/prices";
import type { InvestmentStore } from "@/lib/investments/store";
import { grownByRate } from "@/lib/investments/value";
import { logError } from "@/lib/log";

/** How many days ahead a maturity is mentioned. */
export const MATURITY_NOTICE_DAYS = 3;

const addDays = (day: string, count: number) => new Date(Date.parse(day) + count * 86_400_000).toISOString().slice(0, 10);

/**
 * The once-a-day investments job: refresh prices, then tell people about
 * T-bills, fixed deposits and bonds maturing in the next few days, once each.
 */
export async function runInvestmentsDaily(deps: {
  store: InvestmentStore;
  today: string;
  key: string | null;
  chatFor: (ownerId: string) => Promise<number | null>;
  send: (chatId: number, text: string) => Promise<unknown>;
  messages?: MessageLog | null;
  fetchImpl?: typeof fetch;
}): Promise<{ prices: number; reminded: number }> {
  const prices = await refreshPrices(deps.store, { key: deps.key, today: deps.today, fetchImpl: deps.fetchImpl }).catch((error) => {
    logError("investments_prices", error);
    return { saved: 0 };
  });
  let reminded = 0;
  for (const investment of await deps.store.maturingBy(addDays(deps.today, MATURITY_NOTICE_DAYS))) {
    const chatId = await deps.chatFor(investment.ownerId);
    // Without Telegram there's nowhere to say it; it still shows on the Investments page.
    if (!chatId) continue;
    const principal = Number(investment.principal ?? investment.investedBefore);
    const worth =
      investment.rate != null && investment.startedOn && principal > 0
        ? `, worth about ${formatMinor(Math.round(grownByRate(principal, investment.rate, investment.startedOn, investment.maturesOn!, investment.maturesOn) * 100), investment.currency)}`
        : "";
    const when = investment.maturesOn! < deps.today ? `matured on ${formatDisplayDate(investment.maturesOn!)}` : investment.maturesOn === deps.today ? "matures today" : `matures on ${formatDisplayDate(investment.maturesOn!)}`;
    const text = `Your ${investment.name} ${when}${worth}. Will you roll it over or cash it out? Tell me what you do and I'll update it.`;
    await deps.send(chatId, text);
    await deps.messages?.append({ ownerId: investment.ownerId, role: "assistant", body: text, channel: "telegram", intent: "investments:maturity" }).catch(() => undefined);
    await deps.store.update(investment.ownerId, investment.id, { remindedAt: new Date().toISOString() });
    reminded += 1;
  }
  return { prices: prices.saved, reminded };
}
