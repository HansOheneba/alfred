import { createHash } from "node:crypto";

import type { SupabaseSettings } from "@/lib/config";
import { query } from "@/lib/supabase/connection";

/** Protocol 2 contains no account selector: the forwarding key owns the event. */
export type CollectorEnvelope = { eventId: string; payloadHash: string };
export type CollectorSubmission = {
  envelope: CollectorEnvelope;
  text: string;
  sender: string;
  receivedAt: string;
};
export type CollectorReceipt = CollectorEnvelope & {
  version: 2;
  ownerId: string;
  receiptId: string;
  disposition: "stored" | "duplicate";
};
export type CollectorClaim =
  | { status: "acquired"; claimToken: string }
  | { status: "stored"; receiptId: string }
  | { status: "busy" | "conflict" };
export interface CollectorReceiptStore {
  claim(ownerId: string, event: CollectorEnvelope): Promise<CollectorClaim>;
  complete(ownerId: string, event: CollectorEnvelope, claimToken: string, messageIds: string[]): Promise<string | null>;
  release(ownerId: string, event: CollectorEnvelope, claimToken: string): Promise<void>;
}
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// JSON permits escaped lone UTF16 surrogates, but UTF8 replaces them with U+FFFD.
// Reject them so distinct invalid inputs cannot share one payload fingerprint.
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;

/** Hash exact transmitted fields. No SMS, sender or source GUID is retained here. */
export function collectorPayloadHash(sender: string, receivedAt: string, text: string): string {
  return createHash("sha256").update(`v2\0${sender}\0${receivedAt}\0${text}`, "utf8").digest("hex");
}

/** Legacy Shortcuts keep their old response; new collectors must use this contract. */
export function readCollectorSubmission(raw: string): CollectorSubmission | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (!("protocol" in item)) return null;
  if (item.protocol !== 2 || item.source !== "mac" || typeof item.eventId !== "string" || !HASH.test(item.eventId)
    || typeof item.sender !== "string" || item.sender.length < 1 || item.sender.length > 80 || /[\u0000-\u001f\u007f]/u.test(item.sender) || UNPAIRED_SURROGATE.test(item.sender)
    || typeof item.text !== "string" || !item.text.trim() || item.text.length > 4000 || UNPAIRED_SURROGATE.test(item.text)
    || typeof item.receivedAt !== "string" || item.receivedAt.length > 40 || !Number.isFinite(Date.parse(item.receivedAt))) {
    throw new Error("Invalid collector envelope.");
  }
  return {
    envelope: { eventId: item.eventId, payloadHash: collectorPayloadHash(item.sender, item.receivedAt, item.text) },
    text: item.text,
    sender: item.sender,
    receivedAt: item.receivedAt,
  };
}

export function readCollectorEnvelope(raw: string): CollectorEnvelope | null {
  return readCollectorSubmission(raw)?.envelope ?? null;
}

/** A recipient assertion can only reject; it never selects an account. */
export function collectorExpectedOwner(value: string | null): string {
  if (!value || !UUID.test(value)) throw new Error("Invalid collector account assertion.");
  return value.toLowerCase();
}

export function storedCollectorReceipt(ownerId: string, event: CollectorEnvelope, receiptId: string, duplicate = false): CollectorReceipt {
  if (!UUID.test(ownerId) || !UUID.test(receiptId) || !HASH.test(event.eventId) || !HASH.test(event.payloadHash)) throw new Error("Invalid stored collector receipt.");
  return { version: 2, ownerId, ...event, receiptId, disposition: duplicate ? "duplicate" : "stored" };
}

export function createCollectorReceiptStore(settings: SupabaseSettings): CollectorReceiptStore {
  return {
    async claim(ownerId, event) {
      const [row] = await query<{ status: string; receipt_id: string | null; claim_token: string | null }>(settings,
        "select * from public.alfred_claim_collector_event($1::uuid,$2,$3)", [ownerId, event.eventId, event.payloadHash]);
      if (row?.status === "acquired" && row.claim_token && UUID.test(row.claim_token)) return { status: "acquired", claimToken: row.claim_token };
      if (row?.status === "stored" && row.receipt_id && UUID.test(row.receipt_id)) return { status: "stored", receiptId: row.receipt_id };
      if (row?.status === "busy" || row?.status === "conflict") return { status: row.status };
      throw new Error("Collector receipt unavailable.");
    },
    async complete(ownerId, event, claimToken, messageIds) {
      if (messageIds.length === 0 || messageIds.length > 64 || !messageIds.every(id => UUID.test(id))) return null;
      const [row] = await query<{ receipt_id: string | null }>(settings,
        "select public.alfred_complete_collector_event($1::uuid,$2,$3,$4::uuid,$5::uuid[])::text as receipt_id",
        [ownerId, event.eventId, event.payloadHash, claimToken, messageIds]);
      return row?.receipt_id && UUID.test(row.receipt_id) ? row.receipt_id : null;
    },
    async release(ownerId, event, claimToken) {
      await query(settings, "select public.alfred_release_collector_event($1::uuid,$2,$3,$4::uuid)", [ownerId, event.eventId, event.payloadHash, claimToken]);
    },
  };
}
