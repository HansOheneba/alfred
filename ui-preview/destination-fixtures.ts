import type { InvestmentsData } from "@/app/investments/investments-client";
import type { AboutNote } from "@/lib/notebook/store";
import type { KnownPerson } from "@/lib/web/people";
import type { ReviewItem } from "@/lib/web/review";

import { previewLedger, previewToday } from "./fixture";

/** Artificial companion data for navigating the local UI study. Never seed it. */
export const previewInvestments: InvestmentsData = {
  cash: previewLedger.bank.balances.map((item) => ({ label: item.label, balance: Number(item.balance), at: item.at })),
  portfolio: {
    totalGhs: 5230,
    investedGhs: 5000,
    gainGhs: 230,
    usdGhs: null,
    unconverted: [],
    byKind: [{ kind: "tbill", label: "T-bill", valueGhs: 5230 }],
    items: [{
      investment: {
        id: "demo-investment-tbill",
        ownerId: "00000000-0000-4000-8000-000000000001",
        name: "91-day Treasury bill",
        kind: "tbill",
        provider: "Example investment provider",
        currency: "GHS",
        investedBefore: "5000.00",
        principal: "5000.00",
        rate: null,
        startedOn: "2026-08-15",
        maturesOn: "2026-11-14",
        remindedAt: null,
        payeeKey: null,
        status: "active",
      },
      kindLabel: "T-bill",
      value: 5230,
      valueGhs: 5230,
      source: "reported",
      asOf: previewToday,
      stale: false,
      investedGhs: 5000,
      gainGhs: 230,
      holdings: [],
      maturity: { date: "2026-11-14", daysLeft: 21, valueAtMaturity: null },
    }],
  },
  contributions: [],
};

export const previewReview: ReviewItem[] = previewLedger.bank.needsLabel.map((item) => ({
  id: item.id,
  direction: item.direction,
  amount: item.amount,
  currency: item.currency,
  occurredAt: item.occurredAt,
  who: item.counterparty,
  payeeKey: item.counterparty.toLowerCase().replaceAll(" ", "-"),
  payee: item.counterparty === "Corner store" ? "card" : "person",
  purpose: "",
  owed: null,
  owe: item.counterparty === "Mika" ? "200.00" : null,
}));

export const previewPeople: KnownPerson[] = [
  { personKey: "demo-sam", name: "Sam", note: "A friend who is paying back a shared purchase.", filing: "" },
  { personKey: "demo-mika", name: "Mika", note: "A friend who helped with a one-off expense.", filing: "" },
];

export const previewAbout: AboutNote[] = [
  { id: "demo-note-budgets", note: "I keep separate budgets for food, transport and personal spending.", account: null, createdAt: "2026-10-01T12:00:00Z" },
];
