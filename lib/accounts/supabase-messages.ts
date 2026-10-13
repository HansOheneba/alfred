import type { SupabaseSettings } from "@/lib/config";
import { DatabaseError } from "@/lib/errors";
import type { ChatMessageRecord, MessageLog, NewChatMessage } from "@/lib/accounts/messages";
import { query } from "@/lib/supabase/connection";

type MessageRow = {
  id: string;
  role: "user" | "assistant";
  body: string;
  channel: "web" | "telegram";
  created_at: Date;
  client_id: string | null;
};

function fromRow(row: MessageRow): ChatMessageRecord {
  return {
    id: row.id,
    role: row.role,
    body: row.body,
    channel: row.channel,
    createdAt: row.created_at.toISOString(),
    clientId: row.client_id,
  };
}

const returning = `id, role, body, channel, created_at, client_id`;

export function createSupabaseMessageLog(settings: SupabaseSettings): MessageLog {
  return {
    async listRecent(ownerId, limit) {
      const rows = await query<MessageRow>(
        settings,
        `select ${returning}
         from public.messages
         where owner_id = $1::uuid
         order by created_at desc, id desc
         limit $2::integer`,
        [ownerId, limit],
      );
      return rows.reverse().map(fromRow);
    },
    async listByClientId(ownerId, clientId) {
      const rows = await query<MessageRow>(
        settings,
        `select ${returning}
         from public.messages
         where owner_id = $1::uuid and client_id = $2::text
         order by created_at asc, id asc`,
        [ownerId, clientId],
      );
      return rows.map(fromRow);
    },
    async append(message) {
      const inserted = await insertMessage(settings, message);
      if (!inserted) throw new DatabaseError("The conversation could not be saved.");
      return inserted;
    },
  };
}

async function insertMessage(settings: SupabaseSettings, message: NewChatMessage): Promise<ChatMessageRecord | null> {
  const body = message.body.slice(0, 4000);
  const clientId = message.clientId ?? null;
  if (clientId) {
    const rows = await query<MessageRow>(
      settings,
      `insert into public.messages (conversation_id, owner_id, channel, role, body, client_id)
       select c.id, $1::uuid, $2::text, $3::text, $4::text, $5::text
       from public.conversations c
       where c.owner_id = $1::uuid
       on conflict (owner_id, client_id, role) where client_id is not null
       do update set body = public.messages.body
       returning ${returning}`,
      [message.ownerId, message.channel, message.role, body, clientId],
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }
  const rows = await query<MessageRow>(
    settings,
    `insert into public.messages (conversation_id, owner_id, channel, role, body)
     select c.id, $1::uuid, $2::text, $3::text, $4::text
     from public.conversations c
     where c.owner_id = $1::uuid
     returning ${returning}`,
    [message.ownerId, message.channel, message.role, body],
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

export type { ChatMessageRecord };
