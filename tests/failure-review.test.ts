import { describe, expect, it } from "vitest";

import { findIncidents, type ReviewMessage } from "@/lib/learning/review";

const since = new Date("2026-11-05T00:00:00.000Z");
const now = new Date("2026-11-06T00:00:00.000Z");
const say = (ownerId: string, role: "user" | "assistant", body: string, createdAt: string, intent: string | null = null, bankMessageId: string | null = null): ReviewMessage =>
  ({ ownerId, role, body, createdAt, intent, bankMessageId });

describe("finding conversations that went wrong", () => {
  it("finds Hans's 13:48 conversation as one incident with its context", () => {
    const messages = [
      say("hans", "assistant", "Next: GH₵1,300.00 came in onto your GCB card. What was it?", "2026-11-05T13:46:00.000Z", "bank:label"),
      say("hans", "user", "What do you need from me", "2026-11-05T13:47:00.000Z"),
      say("hans", "assistant", "Confirm that reading and I'll file both.", "2026-11-05T13:47:05.000Z", "chat:money"),
      say("hans", "user", "Yes that's it", "2026-11-05T13:48:00.000Z"),
      say("hans", "assistant", "I couldn't tell which waiting payments you meant. Name the person or the amount.", "2026-11-05T13:48:03.000Z", "bank:label"),
      say("hans", "user", "Yes", "2026-11-05T13:50:00.000Z"),
      say("hans", "assistant", "There's nothing waiting for a yes or no right now.", "2026-11-05T13:50:02.000Z", "answer_confirmation"),
    ];
    const incidents = findIncidents({ messages, traces: [], corrections: [], pending: [], since, now });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ kind: "fallback", ownerId: "hans", count: 2 });
    expect(incidents[0].what).toContain("couldn't tell which");
    expect(incidents[0].what).toContain("nothing to confirm");
    expect(incidents[0].messages.map((message) => message.body)).toContain("What do you need from me");
  });

  it("keeps different people's incidents apart, and skips good replies and old ones", () => {
    const messages = [
      say("hans", "assistant", "Filed GH₵22.50 under Food.", "2026-11-05T10:00:00.000Z"),
      say("mitch", "assistant", "There's nothing waiting for a yes or no right now.", "2026-11-05T10:00:05.000Z"),
      say("hans", "assistant", "That category doesn't fit. Pick one from the list.", "2026-11-04T10:00:00.000Z"),
    ];
    const incidents = findIncidents({ messages, traces: [], corrections: [], pending: [], since, now });
    expect(incidents.map((item) => item.ownerId)).toEqual(["mitch"]);
  });

  it("counts rejected readings, expired proposals and refusals the patterns missed", () => {
    const incidents = findIncidents({
      messages: [say("hans", "assistant", "Here's how I read that: … Save this?", "2026-11-05T08:00:00.000Z", "bank:label")],
      traces: [{ ownerId: "hans", refused: true, actions: ["label_payments"], createdAt: "2026-11-05T20:00:00.000Z" }],
      corrections: [{ ownerId: "hans", kind: "reject", bankMessageId: null, createdAt: "2026-11-05T12:00:00.000Z" }],
      pending: [{ ownerId: "hans", actionType: "label_payments", status: "pending", createdAt: "2026-11-05T08:00:00.000Z", expiresAt: "2026-11-05T08:15:00.000Z" }],
      since, now,
    });
    expect(incidents.map((item) => item.kind)).toEqual(["expired", "rejected", "refused"]);
  });
});
