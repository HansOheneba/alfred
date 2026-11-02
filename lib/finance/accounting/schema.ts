import { z } from "zod";
import type { AccountingAction } from "./types";

/** Also bound the raw HTTP body before parsing; this guards structured callers. */
export const MAX_ACCOUNTING_COMMAND_BYTES = 64 * 1024;

const bounded = (max: number) => z.string().min(1).max(max).refine((value) => value.trim().length > 0);
const id = bounded(200);
const fingerprint = bounded(500);
const text = bounded(120);
const safeInteger = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const positiveMinor = safeInteger.positive();
const timestamp = z.iso.datetime({ offset: true });
const reference = z.strictObject({ movementId: id, sourceFingerprint: fingerprint });
const command = { expectedRevision: safeInteger.nonnegative(), requestId: z.string().regex(/^[\w:.-]{1,200}$/) };

/** Authentication supplies the owner; clients can submit commands, never replacement state. */
export const accountingActionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...command,
    type: z.literal("create_account"),
    account: z.strictObject({
      id, label: text, provider: text, currency: z.string().regex(/^[A-Z]{3}$/), includeInCash: z.boolean(),
    }),
  }),
  z.strictObject({
    ...command,
    type: z.literal("update_account"),
    accountId: id,
    changes: z.strictObject({ label: text.optional(), provider: text.optional(), includeInCash: z.boolean().optional() })
      .refine((changes) => Object.values(changes).some((value) => value !== undefined), "Supply at least one account change."),
  }),
  z.strictObject({ ...command, type: z.literal("assign_movement"), movement: reference, accountId: id }),
  z.strictObject({
    ...command,
    type: z.literal("classify_movement"),
    movement: reference,
    status: z.enum(["confirmed", "review", "hold", "duplicate", "excluded"]),
    category: text.optional(),
  }),
  z.strictObject({
    ...command,
    type: z.literal("record_snapshot"),
    snapshot: z.strictObject({
      id, accountId: id, balanceMinor: safeInteger, occurredAt: timestamp, sourceId: bounded(500),
      sourceMovementId: id.nullable(), sourceFingerprint: fingerprint.optional(),
    }),
  }),
  z.strictObject({ ...command, type: z.literal("pair_transfer"), id, outgoing: reference, incoming: reference }),
  z.strictObject({ ...command, type: z.literal("unpair_transfer"), transferId: id }),
  z.strictObject({
    ...command,
    type: z.literal("save_settlement"),
    settlement: z.strictObject({
      id,
      kind: z.enum(["refund", "loan"]),
      original: reference,
      returns: z.array(z.strictObject({ movementId: id, sourceFingerprint: fingerprint, principalMinor: positiveMinor })).max(100),
    }),
  }),
  z.strictObject({ ...command, type: z.literal("delete_settlement"), settlementId: id }),
  z.strictObject({ ...command, type: z.literal("undo") }),
]).superRefine((action, context) => {
  if (new TextEncoder().encode(JSON.stringify(action)).byteLength > MAX_ACCOUNTING_COMMAND_BYTES) {
    context.addIssue({ code: "custom", message: "Accounting command exceeds 64 KiB." });
  }
}) satisfies z.ZodType<AccountingAction>;
