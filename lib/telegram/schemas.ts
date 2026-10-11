import { z } from "zod";

const chatSchema = z.object({
  id: z.number().int(),
  type: z.string(),
});

const userSchema = z.object({
  id: z.number().int(),
  is_bot: z.boolean().optional(),
  username: z.string().optional(),
  first_name: z.string().optional(),
});

export const telegramUpdateSchema = z
  .object({
    update_id: z.number().int().nonnegative(),
    message: z
      .object({
        message_id: z.number().int(),
        chat: chatSchema,
        from: userSchema.optional(),
        text: z.string().optional(),
        date: z.number().optional(),
      })
      .passthrough()
      .optional(),
    callback_query: z
      .object({
        id: z.string().min(1).max(200),
        from: userSchema,
        data: z.string().max(64).optional(),
        message: z
          .object({
            message_id: z.number().int(),
            chat: chatSchema,
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

export function parseCallbackData(
  data: string,
): { decision: "confirm" | "cancel"; actionId: string } | null {
  const match = /^([cx]):([A-Za-z0-9_-]{8,32})$/.exec(data);
  if (!match) return null;
  return { decision: match[1] === "c" ? "confirm" : "cancel", actionId: match[2] };
}

export function commandName(text: string): string | null {
  const match = /^\/([a-z0-9_]+)(?:@[\w_]+)?(?:\s|$)/i.exec(text.trim());
  return match ? match[1].toLowerCase() : null;
}
