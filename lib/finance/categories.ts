import type { FinanceStore, NewBudget, NewCategory } from "@/lib/finance/store";
import type { CategoryRecord } from "@/lib/finance/types";
export type { CategoryRecord } from "@/lib/finance/types";

export const EXPENSE_CATEGORIES = [
  "Food",
  "Transport",
  "Utilities",
  "Rent & home",
  "Subscriptions",
  "Savings",
  "Emergencies",
  "People",
  "Personal",
  "Social",
  "Fees",
  "Loan repayment",
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
  rent: "Rent & home",
  housing: "Rent & home",
  house: "Rent & home",
  home: "Rent & home",
  "rent and home": "Rent & home",
  "house contribution": "Rent & home",
  landlord: "Rent & home",
  subscriptions: "Subscriptions",
  subscription: "Subscriptions",
  netflix: "Subscriptions",
  spotify: "Subscriptions",
  dstv: "Subscriptions",
  icloud: "Subscriptions",
  fee: "Fees",
  fees: "Fees",
  charges: "Fees",
  "momo fee": "Fees",
  "transaction fee": "Fees",
  "loan repayment": "Loan repayment",
  repayment: "Loan repayment",
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

export function normalizeCategory(raw: string, type: TransactionType, custom: readonly CategoryRecord[] = []): string | null {
  const key = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!key) return null;
  const owned = custom.find((category) => category.type === type && category.name.toLowerCase() === key);
  if (owned) return owned.name;
  if (type === "expense") {
    return canonicalMatch(key, EXPENSE_CATEGORIES) ?? EXPENSE_ALIASES[key] ?? null;
  }
  return canonicalMatch(key, INCOME_CATEGORIES) ?? INCOME_ALIASES[key] ?? null;
}

export function categoryList(type: TransactionType, custom: readonly CategoryRecord[] = []): readonly string[] {
  const defaults = type === "expense" ? EXPENSE_CATEGORIES : INCOME_CATEGORIES;
  return [...defaults, ...custom.filter((category) => category.type === type).map((category) => category.name)];
}

/** Only exact saved names expand the category set; arbitrary model text never does. */
export async function readCategories(store: FinanceStore, userId: string): Promise<CategoryRecord[]> {
  return store.listCategories ? (await store.listCategories(userId)).filter((category) => category.userId === userId) : [];
}

export async function resolveCategory(store: FinanceStore, userId: string, raw: string, type: TransactionType): Promise<string | null> {
  return normalizeCategory(raw, type, await readCategories(store, userId));
}

export function validateCategoryName(raw: string, type: TransactionType, custom: readonly CategoryRecord[] = []): { ok: true; name: string } | { ok: false; message: string } {
  if (type !== "expense" && type !== "income") return { ok: false, message: "Choose an expense or income category." };
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name || name.length > 40 || /[\p{Cc}\p{Cf}]/u.test(raw) || !/^[\p{L}\p{N}][\p{L}\p{N} &'’().,\/-]*$/u.test(name)) {
    return { ok: false, message: "Use a category name of up to 40 letters, numbers, spaces or simple punctuation." };
  }
  if (normalizeCategory(name, type)) {
    return { ok: false, message: `That name already belongs to a built-in ${type} category or one of its aliases.` };
  }
  const existing = custom.find((category) => category.type === type && category.name.toLowerCase() === name.toLowerCase());
  return { ok: true, name: existing?.name ?? name };
}

/** Shared storage guard: a combined write cannot create another owner's or another category's budget. */
export function validCategoryBudget(row: NewCategory, name: string, budget: NewBudget): boolean {
  return row.type === "expense" && row.userId === budget.userId && budget.category.trim().replace(/\s+/g, " ").toLowerCase() === name.toLowerCase()
    && /^(?:0|[1-9]\d{0,6})\.\d{2}$/.test(budget.amount) && Number(budget.amount) > 0 && Number(budget.amount) <= 9_999_999.99
    && /^[A-Z]{3}$/.test(budget.currency) && /^\d{4}-(0[1-9]|1[0-2])$/.test(budget.period);
}
