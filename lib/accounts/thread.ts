import type { ChatChannel, ChatChart, ChatMessageRecord } from "@/lib/accounts/messages";

export type ThreadMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  channel: ChatChannel;
  createdAt: string;
  clientId: string | null;
  actionId?: string | null;
  settled?: boolean;
  status?: "sending" | "sent" | "failed";
  chart?: ChatChart | null;
};

export function toThreadMessage(record: ChatMessageRecord): ThreadMessage {
  return {
    id: record.id,
    role: record.role,
    text: record.body,
    channel: record.channel,
    createdAt: record.createdAt,
    clientId: record.clientId,
    status: "sent",
    chart: record.chart ?? null,
  };
}

export function threadKey(message: Pick<ThreadMessage, "id" | "role" | "clientId">): string {
  return message.clientId ? `${message.role}:${message.clientId}` : message.id;
}

export function compareThread(left: ThreadMessage, right: ThreadMessage): number {
  const byTime = left.createdAt.localeCompare(right.createdAt);
  if (byTime !== 0) return byTime;
  if (left.clientId && left.clientId === right.clientId && left.role !== right.role) {
    return left.role === "user" ? -1 : 1;
  }
  return left.id.localeCompare(right.id);
}

export function mergeThread(current: ThreadMessage[], incoming: ThreadMessage[]): ThreadMessage[] {
  const merged = new Map<string, ThreadMessage>();
  for (const message of current) merged.set(threadKey(message), message);
  for (const message of incoming) {
    const key = threadKey(message);
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, { ...message, status: message.status ?? "sent" });
      continue;
    }
    const incomingStatus = message.status ?? "sent";
    merged.set(key, {
      ...previous,
      ...message,
      text: message.text || previous.text,
      actionId: message.actionId ?? previous.actionId ?? null,
      chart: message.chart ?? previous.chart ?? null,
      settled: message.settled ?? previous.settled,
      status: previous.status === "failed" && incomingStatus === "sent" && message.role === "user" ? "failed" : incomingStatus,
      createdAt: message.createdAt || previous.createdAt,
    });
  }
  const rows = [...merged.values()].sort(compareThread);
  const answered = new Set(
    rows.filter((message) => message.role === "assistant" && message.clientId).map((message) => message.clientId),
  );
  return rows.map((message) =>
    message.role === "user" && message.status === "failed" && message.clientId && answered.has(message.clientId)
      ? { ...message, status: "sent" as const }
      : message,
  );
}
