"use client";

import { useMemo } from "react";
import { ChatPanel } from "@/app/chat/chat-panel";
import { TURN_STREAM } from "@/app/chat/turn-stream";
import type { DrawnChart } from "@/lib/finance/charts";

const ownerId = "fictional-streaming-preview";
const STEPS = [["Reading your message", 700], ["Drawing your chart", 900], ["Putting it into words", 900]] as const;

/** The real chat with a closed sample connection: steps arrive over time, then a reply with a chart. Nothing is sent anywhere. */
export function StreamingChatPreview({ chart, reply }: { chart: DrawnChart; reply: string }) {
  const request = useMemo<typeof fetch>(() => {
    let sequence = 0;
    return async (input, options) => {
      if (!options?.method || options.method === "GET") return Response.json({ ok: true, ownerId, messages: [], choices: [] });
      const body = JSON.parse(String(options.body)) as { text?: string; clientId?: string };
      sequence += 1;
      const clientId = body.clientId ?? `sample-${sequence}`;
      const createdAt = new Date(Date.parse("2026-11-20T12:00:00.000Z") + sequence * 1000).toISOString();
      const messages = [
        { id: `user-${sequence}`, role: "user", channel: "web", body: body.text ?? "", text: body.text ?? "", clientId, createdAt },
        { id: `alfred-${sequence}`, role: "assistant", channel: "web", body: reply, text: reply, clientId, createdAt, chart, ledgerChanged: false },
      ];
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const [text, wait] of STEPS) {
            controller.enqueue(encoder.encode(`${JSON.stringify({ type: "step", text })}\n`));
            await new Promise((resolve) => setTimeout(resolve, wait));
          }
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: "result", status: 200, body: { ok: true, messages, choices: [], ledgerChanged: false } })}\n`));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": TURN_STREAM } });
    };
  }, [chart, reply]);
  return <main className="mx-auto h-dvh max-w-3xl"><ChatPanel ownerId={ownerId} name="Sample" initialMessages={[]} initialChoices={[]} requestData={request} financialsEmpty={false} /></main>;
}
