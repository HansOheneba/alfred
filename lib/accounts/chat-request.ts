import { z } from "zod";

import { isClientMessageId } from "@/lib/accounts/messages";
import { LIMITS } from "@/lib/config";

const clientId = z.string().refine(isClientMessageId, "Invalid message id.");

export const chatTextSchema = z
  .object({
    text: z.string().trim().min(1).max(LIMITS.maxUserTextChars),
    clientId,
  })
  .strict();

export const chatDecisionSchema = z
  .object({
    decision: z.enum(["confirm", "cancel"]),
    actionId: z.string().regex(/^[A-Za-z0-9_-]{8,32}$/),
    clientId,
  })
  .strict();

/** A tapped answer button under a bank payment question. */
export const chatChoiceSchema = z
  .object({
    choice: z.string().regex(/^b:[0-9a-f-]{36}:(?:c\d|t|s|r|l|b|p|i)$/i),
    clientId,
  })
  .strict();
