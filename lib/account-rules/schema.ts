import { z } from "zod";
import type { AccountRuleCommand } from "./types";

export const MAX_ACCOUNT_RULE_COMMAND_BYTES = 16 * 1024;
const bounded = (max: number) => z.string().trim().min(1).max(max).refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), "Control characters are not allowed.");
const uuid = z.uuid();
const accountId = bounded(512);
const command = { expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), requestId: z.string().regex(/^[\w:.-]{1,200}$/) };
const binding = z.strictObject({
  id: uuid, accountId, provider: bounded(120), accountSuffix: z.string().regex(/^\d{3,4}$/), currency: z.string().regex(/^[A-Z]{3}$/), active: z.boolean(),
});
export const accountRuleCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...command, type: z.literal("upsert_rule"), confirmAllScope: z.boolean().optional(), rule: z.strictObject({
    id: uuid, accountId, matchMode: z.enum(["exact", "all"]), merchantExact: bounded(2000).nullable(),
    direction: z.enum(["in", "out", "any"]).optional(), category: bounded(120).refine((value) => !/[\r\n\t]/.test(value), "Category must be a single line."), active: z.boolean().optional(), priority: z.number().int().min(-1000).max(1000).optional(),
    effectiveFrom: z.iso.datetime({ offset: true }).optional(),
  }) }),
  z.strictObject({ ...command, type: z.literal("delete_rule"), ruleId: uuid }),
  z.strictObject({ ...command, type: z.literal("set_rule_active"), ruleId: uuid, active: z.boolean(), confirmAllScope: z.boolean().optional() }),
  z.strictObject({ ...command, type: z.literal("save_binding"), binding }),
  z.strictObject({ ...command, type: z.literal("delete_binding"), bindingId: uuid }),
]).superRefine((value, context) => {
  if (value.type === "upsert_rule") {
    if (value.rule.matchMode === "exact" && value.rule.merchantExact === null) context.addIssue({ code: "custom", message: "An exact merchant descriptor is required." });
    if (value.rule.matchMode === "all" && (value.rule.merchantExact !== null || value.confirmAllScope !== true)) context.addIssue({ code: "custom", message: "Confirm explicitly that this rule covers every merchant on the selected account." });
  }
}) satisfies z.ZodType<AccountRuleCommand>;
