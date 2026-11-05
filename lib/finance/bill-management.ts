import { saveConfirmation, type ActionContext, type Delivery } from "@/lib/finance/action-router";
import {
  billManagementActionSchema, billManagementPendingSchema,
  type BillManagementAction, type BillManagementPending,
} from "@/lib/finance/bill-management-schema";
import { nextOccurrence, type BillRecord, type BillStore, type ConfirmedBillOperation } from "@/lib/finance/bills";
import { zonedYmd } from "@/lib/finance/dates";
import { formatMoneyAmount } from "@/lib/telegram/messages";

type BillContext = ActionContext & { bills?: BillStore | null };
const TRACKING_ONLY = "This changes Alfred's tracking and reminders. It does not pay or cancel anything with the provider.";
const unavailable = (): Delivery => ({ kind: "text", text: "I can't manage saved bills right now. Nothing was changed." });
const nameKey = (name: string) => name.trim().toLocaleLowerCase("en");

function describe(bill: BillRecord): string {
  return `${bill.name}: ${bill.amount === null ? `variable amount (${bill.currency})` : formatMoneyAmount(bill.amount, bill.currency)}, ${bill.cadence}, next date ${bill.nextDate}, tracking ${bill.active ? "active" : "paused"}.`;
}

function sameTerms(left: BillRecord, right: BillRecord): boolean {
  return left.name === right.name && left.nextDate === right.nextDate && left.amount === right.amount
    && left.currency === right.currency && left.cadence === right.cadence && left.active === right.active;
}

async function confirmation(ctx: BillContext, text: string, payload: BillManagementPending): Promise<Delivery> {
  return saveConfirmation(ctx, `${text}\n\nConfirm or cancel.`, payload);
}

/** Only reads that distinguish an unavailable database from an empty list may drive conversational changes. */
export async function handleBillManagement(input: BillManagementAction, ctx: BillContext): Promise<Delivery> {
  const parsed = billManagementActionSchema.safeParse(input);
  if (!parsed.success) return { kind: "text", text: "Those bill details aren't valid. Check the name, amount, date, currency and repeat schedule." };
  const action = parsed.data;
  if (!ctx.bills?.strictList) return unavailable();
  let bills: BillRecord[];
  try { bills = (await ctx.bills.strictList(ctx.profile.profileId)).filter(bill => bill.ownerId === ctx.profile.profileId); }
  catch { return unavailable(); }
  if (action.type === "get_bills") {
    const rows = bills.filter(bill => (action.include_inactive || bill.active) && (!action.name || nameKey(bill.name) === nameKey(action.name)));
    if (!rows.length) return { kind: "text", text: action.name ? "I couldn't find a matching tracked bill in that list." : action.include_inactive ? "You have no saved bills." : "You have no active tracked bills." };
    const today = zonedYmd(ctx.now, ctx.profile.timezone);
    return { kind: "text", text: ["Saved bills:", ...rows.slice(0,20).map(bill => {
      const due = nextOccurrence(bill, today);
      return `- ${bill.id} — ${describe(bill)}${due && due !== bill.nextDate ? ` Next occurrence ${due}.` : ""}`;
    }), ...(rows.length > 20 ? [`${rows.length - 20} more bills are not shown. Ask for an exact name to narrow the list.`] : []), "These are expected bills, not evidence of payments."].join("\n") };
  }
  if (!ctx.bills.applyConfirmed) return unavailable();
  if (action.type === "create_bill") {
    const missing = [!action.next_date && "next due date", !action.currency && "currency", !action.cadence && "repeat schedule (once, weekly, monthly or yearly)", action.amount === undefined && "amount (or say it varies)"].filter(Boolean);
    if (missing.length) return { kind: "text", text: `What ${missing.join(", ")} should I use for ${action.name}?` };
    if (bills.some(bill => nameKey(bill.name) === nameKey(action.name))) return { kind: "text", text: `You already have a bill named ${action.name}. Ask me to update it, or give the new bill a different name.` };
    const timestamp = ctx.now.toISOString();
    const bill: BillRecord = {
      id: ctx.createId(), ownerId: ctx.profile.profileId, name: action.name,
      nextDate: action.next_date!, amount: action.amount!, currency: action.currency!, cadence: action.cadence!,
      active: true, createdAt: timestamp, updatedAt: timestamp,
    };
    return confirmation(ctx, `Track this bill?\n${describe(bill)}\nIt records an expected bill and does not pay it.`, { type: "create_bill", originUpdateId: String(ctx.updateId), bill });
  }
  if (!action.bill_id && !action.name) return { kind: "text", text: "Which saved bill do you mean? Tell me its exact name." };
  const matches = bills.filter(bill => (!action.bill_id || bill.id === action.bill_id) && (!action.name || nameKey(bill.name) === nameKey(action.name)));
  if (matches.length !== 1) return { kind: "text", text: matches.length
    ? ["More than one saved bill has that name. Choose the bill ID from these records:",
      ...matches.slice(0,20).map(bill => `- ${bill.id} — ${describe(bill)}`),
      ...(matches.length > 20 ? [`${matches.length - 20} more matching bills are not shown. Open Bills & renewals on Overview to choose the exact record.`] : [])].join("\n")
    : "I couldn't find that saved bill. Nothing was changed." };
  const before = matches[0];
  if (action.type === "delete_bill") {
    return confirmation(ctx, `Remove this tracked bill?\n${describe(before)}\n${TRACKING_ONLY}`, { type: "delete_bill", originUpdateId: String(ctx.updateId), before });
  }
  const after: BillRecord = action.type === "set_bill_active"
    ? { ...before, active: action.active, updatedAt: ctx.now.toISOString() }
    : { ...before, name: action.changes.name ?? before.name, nextDate: action.changes.next_date ?? before.nextDate,
      amount: action.changes.amount === undefined ? before.amount : action.changes.amount,
      currency: action.changes.currency ?? before.currency, cadence: action.changes.cadence ?? before.cadence,
      updatedAt: ctx.now.toISOString() };
  if (sameTerms(before, after)) return { kind: "text", text: "That bill already has those settings. Nothing was changed." };
  return confirmation(ctx, `${action.type === "set_bill_active" ? action.active ? "Resume" : "Pause" : "Update"} this tracked bill?\nBefore: ${describe(before)}\nAfter: ${describe(after)}\n${TRACKING_ONLY}`, {
    type: action.type, originUpdateId: String(ctx.updateId), before, after,
  });
}

/** Applies the exact reviewed bill snapshot; the store rejects changes made after it was shown. */
export async function executeBillManagement(input: BillManagementPending, ctx: BillContext): Promise<{ text: string }> {
  const parsed = billManagementPendingSchema.safeParse(input);
  if (!parsed.success || !ctx.bills?.applyConfirmed) return { text: "That bill confirmation is unavailable. Nothing was changed." };
  const payload = parsed.data;
  const operation: ConfirmedBillOperation = payload.type === "create_bill" ? { kind: "create", bill: payload.bill }
    : payload.type === "delete_bill" ? { kind: "delete", before: payload.before }
    : { kind: "update", before: payload.before, after: payload.after };
  const result = await ctx.bills.applyConfirmed(ctx.profile.profileId, operation);
  if (result === "stale") return { text: "That bill changed since I asked. Nothing was changed. Ask again to review its current settings." };
  if (result === "missing") return { text: "That bill is no longer available for this account. Nothing was changed." };
  if (result === "already_applied") return { text: "That exact bill change was already saved." };
  if (payload.type === "create_bill") return { text: `Tracked ${describe(payload.bill)}\nIt records an expected bill and does not pay it.` };
  if (payload.type === "delete_bill") return { text: `Removed ${payload.before.name} from Alfred's tracked bills. ${TRACKING_ONLY}` };
  return { text: `${payload.type === "set_bill_active" ? payload.after.active ? "Resumed" : "Paused" : "Updated"} ${describe(payload.after)}\n${TRACKING_ONLY}` };
}
