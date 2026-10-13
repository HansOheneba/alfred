export type ChatChannel = "web" | "telegram";

export type ChatMessageRecord = {
  id: string;
  role: "user" | "assistant";
  body: string;
  channel: ChatChannel;
  createdAt: string;
  clientId: string | null;
};

export type NewChatMessage = {
  ownerId: string;
  role: "user" | "assistant";
  body: string;
  channel: ChatChannel;
  clientId?: string | null;
};

export interface MessageLog {
  listRecent(ownerId: string, limit: number): Promise<ChatMessageRecord[]>;
  listByClientId(ownerId: string, clientId: string): Promise<ChatMessageRecord[]>;
  append(message: NewChatMessage): Promise<ChatMessageRecord>;
}

const CLIENT_ID = /^[A-Za-z0-9_-]{8,80}$/;

export function isClientMessageId(value: string): boolean {
  return CLIENT_ID.test(value);
}

/**
 * Claim key for one web submission. The offset keeps it above Telegram update
 * ids and below studio ids based on Date.now() * 1000.
 */
export function clientTurnUpdateId(clientId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < clientId.length; index += 1) {
    hash ^= clientId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) + 1_000_000_000_000;
}

export class MemoryMessageLog implements MessageLog {
  private readonly rows: (ChatMessageRecord & { ownerId: string })[] = [];

  async listRecent(ownerId: string, limit: number): Promise<ChatMessageRecord[]> {
    return this.rows
      .filter((row) => row.ownerId === ownerId)
      .slice(-limit)
      .map((row) => this.publicRow(row));
  }

  async listByClientId(ownerId: string, clientId: string): Promise<ChatMessageRecord[]> {
    return this.rows
      .filter((row) => row.ownerId === ownerId && row.clientId === clientId)
      .map((row) => this.publicRow(row));
  }

  async append(message: NewChatMessage): Promise<ChatMessageRecord> {
    const clientId = message.clientId ?? null;
    if (clientId) {
      const existing = this.rows.find(
        (row) => row.ownerId === message.ownerId && row.clientId === clientId && row.role === message.role,
      );
      if (existing) return this.publicRow(existing);
    }
    const row = {
      id: `mem-${this.rows.length + 1}`,
      ownerId: message.ownerId,
      role: message.role,
      body: message.body,
      channel: message.channel,
      clientId,
      createdAt: new Date(this.rows.length).toISOString(),
    };
    this.rows.push(row);
    return this.publicRow(row);
  }

  private publicRow(row: ChatMessageRecord): ChatMessageRecord {
    return {
      id: row.id,
      role: row.role,
      body: row.body,
      channel: row.channel,
      createdAt: row.createdAt,
      clientId: row.clientId,
    };
  }
}
