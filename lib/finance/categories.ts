export const EXPENSE_CATEGORIES = [
  "Food",
  "Transport",
  "Utilities",
  "Subscriptions",
  "Savings",
  "Emergencies",
  "People",
  "Personal",
  "Social",
  "Misc",
] as const;

export const INCOME_CATEGORIES = ["Salary", "Business", "Gift", "Refund", "Other"] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export type IncomeCategory = (typeof INCOME_CATEGORIES)[number];
export type TransactionType = "income" | "expense";

const EXPENSE_ALIASES: Record<string, ExpenseCategory> = {
  food: "Food",
  lunch: "Food",
  dinner: "Food",
  breakfast: "Food",
  groceries: "Food",
  grocery: "Food",
  restaurant: "Food",
  chop: "Food",
  snack: "Food",
  snacks: "Food",
  porridge: "Food",
  indomie: "Food",
  waakye: "Food",
  coffee: "Food",
  transport: "Transport",
  uber: "Transport",
  bolt: "Transport",
  trotro: "Transport",
  taxi: "Transport",
  fuel: "Transport",
  gas: "Transport",
  petrol: "Transport",
  okada: "Transport",
  bus: "Transport",
  ride: "Transport",
  utilities: "Utilities",
  utility: "Utilities",
  electricity: "Utilities",
  water: "Utilities",
  internet: "Utilities",
  data: "Utilities",
  airtime: "Utilities",
  ecg: "Utilities",
  bill: "Utilities",
  bills: "Utilities",
  subscriptions: "Subscriptions",
  subscription: "Subscriptions",
  netflix: "Subscriptions",
  spotify: "Subscriptions",
  dstv: "Subscriptions",
  icloud: "Subscriptions",
  savings: "Savings",
  save: "Savings",
  emergencies: "Emergencies",
  emergency: "Emergencies",
  people: "People",
  loan: "People",
  support: "People",
  family: "People",
  parents: "People",
  mum: "People",
  mom: "People",
  dad: "People",
  personal: "Personal",
  cosmetics: "Personal",
  sneakers: "Personal",
  clothes: "Personal",
  clothing: "Personal",
  health: "Personal",
  medicine: "Personal",
  pharmacy: "Personal",
  toiletries: "Personal",
  haircut: "Personal",
  social: "Social",
  drinks: "Social",
  bar: "Social",
  party: "Social",
  outing: "Social",
  entertainment: "Social",
  misc: "Misc",
  miscellaneous: "Misc",
  other: "Misc",
};

const INCOME_ALIASES: Record<string, IncomeCategory> = {
  salary: "Salary",
  paycheck: "Salary",
  wage: "Salary",
  wages: "Salary",
  business: "Business",
  freelance: "Business",
  sales: "Business",
  gift: "Gift",
  present: "Gift",
  refund: "Refund",
  reimbursement: "Refund",
  other: "Other",
  misc: "Other",
};

function canonicalMatch<T extends string>(value: string, categories: readonly T[]): T | null {
  const match = categories.find((category) => category.toLowerCase() === value);
  return match ?? null;
}

export function normalizeCategory(raw: string, type: TransactionType): string | null {
  const key = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!key) return null;
  if (type === "expense") {
    return canonicalMatch(key, EXPENSE_CATEGORIES) ?? EXPENSE_ALIASES[key] ?? null;
  }
  return canonicalMatch(key, INCOME_CATEGORIES) ?? INCOME_ALIASES[key] ?? null;
}

export function categoryList(type: TransactionType): readonly string[] {
  return type === "expense" ? EXPENSE_CATEGORIES : INCOME_CATEGORIES;
}
