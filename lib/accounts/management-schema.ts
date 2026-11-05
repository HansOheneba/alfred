import { z } from "zod";

const text = z.string().trim().min(1).max(120).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value), "Use plain text for account names and providers.");
const accountId = z.string().trim().min(1).max(200);
const currency = z.string().regex(/^[A-Z]{3}$/);
const accountChanges = z.object({
  label: text.nullable().optional(),
  provider: text.nullable().optional(),
  include_in_cash: z.boolean().nullable().optional(),
}).refine(changes => Object.values(changes).some(value => value != null), "Supply an account change.");

/** These configure financial accounts, independently of the owner's sign-in profile. */
export const accountActionSchemas = [
  z.object({ type: z.literal("get_accounts") }),
  z.object({
    type: z.literal("create_account"), label: text, provider: text.nullable().optional(),
    currency: currency.nullable().optional(), include_in_cash: z.boolean().nullable().optional(),
  }),
  z.object({
    type: z.literal("update_account"), account_id: accountId.nullable().optional(), name: text.nullable().optional(), changes: accountChanges,
  }),
] as const;
export const accountManagementActionSchema = z.discriminatedUnion("type", accountActionSchemas);
export type AccountManagementAction = z.infer<typeof accountManagementActionSchema>;

const commandFields = {
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  requestId: z.string().regex(/^[\w:.-]{1,200}$/),
};
const createCommand = z.strictObject({
  ...commandFields, type: z.literal("create_account"),
  account: z.strictObject({ id: accountId, label: text, provider: text, currency, includeInCash: z.boolean() }),
});
const updateCommand = z.strictObject({
  ...commandFields, type: z.literal("update_account"), accountId,
  changes: z.strictObject({ label: text.optional(), provider: text.optional(), includeInCash: z.boolean().optional() })
    .refine(changes => Object.values(changes).some(value => value !== undefined), "Supply an account change."),
});
const originUpdateId = z.string().regex(/^\d+$/);
export const accountPendingSchemas = [
  z.object({ type: z.literal("create_account"), originUpdateId, command: createCommand }),
  z.object({ type: z.literal("update_account"), originUpdateId, command: updateCommand }),
] as const;
export const accountManagementPendingSchema = z.discriminatedUnion("type", accountPendingSchemas);
export type AccountManagementPending = z.infer<typeof accountManagementPendingSchema>;
export type AccountConfigurationCommand = AccountManagementPending["command"];
