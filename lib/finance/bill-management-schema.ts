import { z } from "zod";

import { LIMITS } from "@/lib/config";
import { isRealDate } from "@/lib/finance/dates";
import { toMinor } from "@/lib/finance/money";

// Independent primitives keep these fragments safe to import into the shared action schemas.
const amount = z.string().regex(/^(?:0|[1-9]\d{0,6})\.\d{2}$/).refine(value => toMinor(value) > 0 && toMinor(value) <= LIMITS.maxMinor);
const currency = z.string().regex(/^[A-Z]{3}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDate);
const cadence = z.enum(["once", "weekly", "monthly", "yearly"]);
const name = z.string().trim().min(1).max(80).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value));
const target = { bill_id: z.string().uuid().nullable().optional(), name: name.nullable().optional() };

export const billRecordSchema = z.object({
  id: z.string().uuid(), ownerId: z.string().min(1).max(80), name,
  nextDate: date, amount: amount.nullable(), currency, cadence, active: z.boolean(),
  createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
});

export const billActionSchemas = [
  z.object({ type: z.literal("get_bills"), name: name.nullable().optional(), include_inactive: z.boolean().optional() }),
  z.object({
    type: z.literal("create_bill"), name,
    next_date: date.nullable().optional(), amount: amount.nullable().optional(),
    currency: currency.nullable().optional(), cadence: cadence.nullable().optional(),
  }),
  z.object({
    type: z.literal("update_bill"), ...target,
    changes: z.object({
      name: name.optional(), next_date: date.optional(), amount: amount.nullable().optional(),
      currency: currency.optional(), cadence: cadence.optional(),
    }).refine(value => Object.values(value).some(item => item !== undefined)),
  }),
  z.object({ type: z.literal("set_bill_active"), ...target, active: z.boolean() }),
  z.object({ type: z.literal("delete_bill"), ...target }),
] as const;

const originUpdateId = z.string().regex(/^\d+$/);
export const billPendingSchemas = [
  z.object({ type: z.literal("create_bill"), originUpdateId, bill: billRecordSchema }),
  z.object({ type: z.literal("update_bill"), originUpdateId, before: billRecordSchema, after: billRecordSchema }),
  z.object({ type: z.literal("set_bill_active"), originUpdateId, before: billRecordSchema, after: billRecordSchema }),
  z.object({ type: z.literal("delete_bill"), originUpdateId, before: billRecordSchema }),
] as const;

export const billManagementActionSchema = z.discriminatedUnion("type", billActionSchemas);
export const billManagementPendingSchema = z.discriminatedUnion("type", billPendingSchemas);
export type BillManagementAction = z.infer<typeof billManagementActionSchema>;
export type BillManagementPending = z.infer<typeof billManagementPendingSchema>;
