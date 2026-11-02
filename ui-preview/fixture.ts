import type { LedgerRow } from "@/lib/finance/analytics";
import type { BillRecord } from "@/lib/finance/bills";
import type { Ledger, LedgerBudget } from "@/lib/web/ledger";

/**
 * Artificial, deterministic UI-preview data. Nothing in this file comes from a
 * person, a bank, a database, or an environment variable. Never seed it into a
 * real account. All monetary calculations use integer minor units.
 */
export const previewName = "Alex";
export const previewToday = "2026-10-24";
const currency = "GHS";
export type PreviewAccount = { id: string; label: string; balance: string; currency: string; reportedAt: string; included: boolean };
const demoOwnerId = "00000000-0000-4000-8000-000000000001";

function transaction(
  id: string,
  date: string,
  type: LedgerRow["type"],
  minor: number,
  category: string,
  description: string,
  paymentMethod: string,
): LedgerRow {
  return { id: `demo-${id}`, date, type, minor, amount: (minor / 100).toFixed(2), currency, category, description, paymentMethod };
}

// Eleven previous months plus October make all twelve monthly chart buckets
// meaningful. Multipliers are fixed, so refreshes always produce the same chart.
const history: LedgerRow[] = [];
const monthlyFactors = [94, 109, 87, 92, 101, 96, 112, 103, 108, 98, 105];
for (let index = 0; index < monthlyFactors.length; index += 1) {
  const month = new Date(Date.UTC(2025, 10 + index, 1)).toISOString().slice(0, 7);
  const factor = monthlyFactors[index];
  const scaled = (minor: number) => Math.round((minor * factor) / 100);
  history.push(
    transaction(`${month}-salary`, `${month}-01`, "income", 820000 + index * 8500, "Salary", "Monthly salary", "GCB card"),
    transaction(`${month}-business`, `${month}-18`, "income", 110000 + (index % 4) * 17500, "Business", "Design project", "MoMo"),
    transaction(`${month}-rent`, `${month}-02`, "expense", 180000, "Rent & home", "Home rent", "GCB card"),
    transaction(`${month}-food-a`, `${month}-04`, "expense", scaled(52780), "Food", "Market groceries", "MoMo"),
    transaction(`${month}-food-b`, `${month}-11`, "expense", scaled(31850), "Food", "Weekly groceries", "GCB card"),
    transaction(`${month}-food-c`, `${month}-20`, "expense", scaled(28600), "Food", "Lunches and coffee", "Manual / cash"),
    transaction(`${month}-transport-a`, `${month}-06`, "expense", scaled(33800), "Transport", "Fuel", "GCB card"),
    transaction(`${month}-transport-b`, `${month}-17`, "expense", scaled(19400), "Transport", "Rides around town", "MoMo"),
    transaction(`${month}-utilities`, `${month}-08`, "expense", scaled(64500), "Utilities", "Power and home internet", "MoMo"),
    transaction(`${month}-personal`, `${month}-13`, "expense", scaled(49600), "Personal", "Clothing and essentials", "GCB card"),
    transaction(`${month}-social`, `${month}-22`, "expense", scaled(35250), "Social", "Dinner with friends", "MoMo"),
    transaction(`${month}-subscriptions`, `${month}-23`, "expense", 15900, "Subscriptions", "Digital subscriptions", "GCB card"),
  );
}

const october: LedgerRow[] = [
  transaction("oct-salary", "2026-10-01", "income", 940000, "Salary", "Monthly salary", "GCB card"),
  transaction("oct-rent", "2026-10-02", "expense", 180000, "Rent & home", "Home rent", "GCB card"),
  transaction("oct-food-01", "2026-10-02", "expense", 28450, "Food", "Market groceries", "MoMo"),
  transaction("oct-ride-01", "2026-10-03", "expense", 4850, "Transport", "Bolt ride", "MoMo"),
  transaction("oct-food-02", "2026-10-04", "expense", 6200, "Food", "Lunch at Green Bowl", "GCB card"),
  transaction("oct-fuel", "2026-10-05", "expense", 33000, "Transport", "Fuel", "GCB card"),
  transaction("oct-internet", "2026-10-06", "expense", 35000, "Utilities", "Home internet", "MoMo"),
  transaction("oct-food-03", "2026-10-06", "expense", 7300, "Food", "Lunch and coffee", "Manual / cash"),
  transaction("oct-power", "2026-10-07", "expense", 22500, "Utilities", "Electricity top-up", "MoMo"),
  transaction("oct-food-04", "2026-10-08", "expense", 21980, "Food", "Weekly groceries", "GCB card"),
  transaction("oct-social-01", "2026-10-09", "expense", 24750, "Social", "Dinner with friends", "GCB card"),
  transaction("oct-personal-01", "2026-10-10", "expense", 14500, "Personal", "Haircut and essentials", "MoMo"),
  transaction("oct-ride-02", "2026-10-11", "expense", 6400, "Transport", "Bolt ride", "MoMo"),
  transaction("oct-food-05", "2026-10-12", "expense", 5550, "Food", "Lunch at Green Bowl", "MoMo"),
  transaction("oct-data", "2026-10-13", "expense", 9500, "Utilities", "Mobile data", "MoMo"),
  transaction("oct-food-06", "2026-10-14", "expense", 17800, "Food", "Market groceries", "Manual / cash"),
  transaction("oct-ride-03", "2026-10-15", "expense", 3800, "Transport", "Ride home", "MoMo"),
  transaction("oct-personal-02", "2026-10-16", "expense", 32900, "Personal", "Walking shoes", "GCB card"),
  transaction("oct-social-02", "2026-10-17", "expense", 17200, "Social", "Weekend lunch", "MoMo"),
  transaction("oct-business", "2026-10-18", "income", 165000, "Business", "Design project", "MoMo"),
  transaction("oct-food-07", "2026-10-18", "expense", 26400, "Food", "Weekly groceries", "GCB card"),
  transaction("oct-food-08", "2026-10-19", "expense", 4800, "Food", "Lunch and coffee", "MoMo"),
  transaction("oct-ride-04", "2026-10-20", "expense", 5200, "Transport", "Bolt ride", "MoMo"),
  transaction("oct-subscription", "2026-10-21", "expense", 5900, "Subscriptions", "Music subscription", "GCB card"),
  transaction("oct-food-09", "2026-10-21", "expense", 8700, "Food", "Lunch at Green Bowl", "GCB card"),
  transaction("oct-food-10", "2026-10-22", "expense", 15680, "Food", "Market groceries", "MoMo"),
  transaction("oct-ride-05", "2026-10-23", "expense", 4550, "Transport", "Ride home", "MoMo"),
  transaction("oct-food-11", "2026-10-24", "expense", 7400, "Food", "Saturday breakfast", "GCB card"),
  transaction("oct-fees", "2026-10-24", "expense", 475, "Fees", "Transfer charges", "MoMo"),
];

const rows = [...history, ...october].sort((left, right) => right.date.localeCompare(left.date) || left.id.localeCompare(right.id));
const expenseTotal = october.filter((row) => row.type === "expense").reduce((sum, row) => sum + row.minor, 0);
const incomeTotal = october.filter((row) => row.type === "income").reduce((sum, row) => sum + row.minor, 0);
const keptPercent = Math.round(((incomeTotal - expenseTotal) / incomeTotal) * 100);

const budgets: LedgerBudget[] = ([
  ["Food", 180000],
  ["Transport", 85000],
  ["Personal", 65000],
] as const).map(([category, budgetMinor], index) => {
  const spentMinor = october.filter((row) => row.type === "expense" && row.category === category).reduce((sum, row) => sum + row.minor, 0);
  return { budgetId: `demo-budget-${index}`, period: "2026-10", category, currency, amount: (budgetMinor / 100).toFixed(2), spentMinor, budgetMinor, remainingMinor: budgetMinor - spentMinor };
});

const bills: BillRecord[] = [
  { id: "demo-bill-music", ownerId: demoOwnerId, name: "Music subscription", nextDate: "2026-11-21", amount: "59.00", currency, cadence: "monthly", active: true, createdAt: "2026-06-21T12:00:00Z", updatedAt: "2026-10-21T12:00:00Z" },
  { id: "demo-bill-rent", ownerId: demoOwnerId, name: "Home rent", nextDate: "2026-11-02", amount: "1800.00", currency, cadence: "monthly", active: true, createdAt: "2026-06-02T12:00:00Z", updatedAt: "2026-10-02T12:00:00Z" },
  { id: "demo-bill-internet", ownerId: demoOwnerId, name: "Home internet", nextDate: "2026-11-06", amount: "350.00", currency, cadence: "monthly", active: true, createdAt: "2026-06-06T12:00:00Z", updatedAt: "2026-10-06T12:00:00Z" },
];

export const previewLedger: Ledger = {
  today: previewToday,
  currency,
  rows,
  budgets,
  goals: [
    { goalId: "demo-goal-buffer", name: "Emergency fund", targetAmount: "18000.00", currentAmount: "12450.00", currency, targetDate: "2027-03-31", status: "active" },
    { goalId: "demo-goal-trip", name: "December trip", targetAmount: "6500.00", currentAmount: "3875.00", currency, targetDate: "2026-12-15", status: "active" },
  ],
  insights: [
    `You've kept ${keptPercent}% of your recorded income this month.`,
    `Food has used ${Math.round((budgets[0].spentMinor / budgets[0].budgetMinor) * 100)}% of its monthly budget.`,
    "Home rent is your largest spending category this month.",
  ],
  bank: {
    connected: true,
    lastUsedAt: "2026-10-24T09:42:00Z",
    lastEmptyAt: null,
    accountNames: ["GCB card", "MoMo"],
    balances: [
      { source: "gcb", label: "GCB card", balance: "12485.75", at: "2026-10-24T09:42:00Z" },
      { source: "momo", label: "MoMo", balance: "1832.40", at: "2026-10-24T08:16:00Z" },
    ],
    needsLabel: [
      { id: "demo-review-1", direction: "out", amount: "85.00", currency, counterparty: "Corner store", occurredAt: "2026-10-24T08:16:00Z", question: "What was the Corner store payment for?" },
      { id: "demo-review-2", direction: "out", amount: "120.00", currency, counterparty: "Mika", occurredAt: "2026-10-23T17:20:00Z", question: "What was the transfer to Mika for?" },
    ],
  },
  owed: [
    { person: "Sam", personKey: "sam", lent: "600.00", repaid: "150.00", owed: "450.00", borrowed: "0.00", paidBack: "0.00", owe: "0.00", currency, since: "2026-10-12T12:00:00Z" },
  ],
  owe: [
    { person: "Mika", personKey: "mika", lent: "0.00", repaid: "0.00", owed: "0.00", borrowed: "300.00", paidBack: "100.00", owe: "200.00", currency, since: "2026-10-10T12:00:00Z" },
  ],
  bills,
  upcomingBills: bills.map((bill) => ({ ...bill, renewalDate: bill.nextDate })).sort((left, right) => left.renewalDate.localeCompare(right.renewalDate)),
  renewalSuggestions: [],
};

/** Explicit account identity/inclusion exists only in this synthetic UI study.
 * Production LedgerBalance currently identifies provider sources, not accounts. */
export const previewAccounts: PreviewAccount[] = previewLedger.bank.balances.map((balance) => ({
  id: `demo-account-${balance.source}`,
  label: balance.label,
  balance: balance.balance,
  currency,
  reportedAt: balance.at,
  included: true,
}));
