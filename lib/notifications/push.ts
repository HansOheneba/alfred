import { DASHBOARD_URL } from "@/lib/config";
import { paymentTargetId } from './payment-target';

/** Subscription secrets are server-only; never put endpoints or keys in logs. */
export type PushSubscriptionRecord = {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
};
export type QueuedPushKind = "payment" | "bill" | "weekly";
export type PushKind = QueuedPushKind | "test";
export type PushConfiguration = { publicKey: string; privateKey: string; subject: string };
export type PushEnvironment = Record<string, string | undefined>;
export type PushStage = "authorization" | "encryption" | "connection";
export class PushFailure extends Error {
  constructor(readonly stage: PushStage) {
    super(`Push ${stage} failed.`);
    this.name = "PushFailure";
  }
}
const encoder = new TextEncoder();
type Bytes = Uint8Array<ArrayBuffer>;
export function base64url(value: ArrayBuffer | Uint8Array): string {
  return Buffer.from(value instanceof Uint8Array ? value : new Uint8Array(value)).toString("base64url");
}
export function decodeBase64url(value: string): Bytes {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid push key.");
  const decoded = new Uint8Array(Buffer.from(value, "base64url"));
  if (base64url(decoded) !== value) throw new Error("Invalid push key.");
  return decoded;
}
function concat(...parts: Uint8Array[]): Bytes {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
function subjectAllowed(value: string): boolean {
  if (value.length > 512 || /[\r\n]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol === "mailto:") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(url.pathname) && !url.search && !url.hash;
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
/** Readiness is format validation only; it never creates, returns or tests a private key. */
export function pushConfiguration(env: PushEnvironment = process.env): {
  ready: boolean; publicKey: string | null; config: PushConfiguration | null;
} {
  try {
    const publicKey = env.VAPID_PUBLIC_KEY?.trim() ?? "";
    const privateKey = env.VAPID_PRIVATE_KEY?.trim() ?? "";
    const subject = env.VAPID_SUBJECT?.trim() ?? "";
    if (publicKey.length !== 87 || privateKey.length !== 43) throw new Error();
    const publicBytes = decodeBase64url(publicKey), privateBytes = decodeBase64url(privateKey);
    if (publicBytes.length !== 65 || publicBytes[0] !== 4 || privateBytes.length !== 32 || !subjectAllowed(subject)) throw new Error();
    return { ready: true, publicKey, config: { publicKey, privateKey, subject } };
  } catch { return { ready: false, publicKey: null, config: null }; }
}

/** Strict host allowlist prevents subscription endpoints becoming an SSRF proxy. */
export function endpointAllowed(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || /[\r\n]/.test(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname;
    return url.href === value && url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash &&
      url.pathname.length > 1 &&
      (host === "fcm.googleapis.com" || host === "updates.push.services.mozilla.com" ||
       (host.endsWith(".push.apple.com") && /^[a-z0-9.-]+$/.test(host)));
  } catch { return false; }
}
export async function validateSubscription(input: unknown, now = Date.now()): Promise<PushSubscriptionRecord> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid push subscription.");
  const value = input as Record<string, unknown>;
  if (!endpointAllowed(value.endpoint) || !value.keys || typeof value.keys !== "object" || Array.isArray(value.keys)) throw new Error("Invalid push subscription.");
  if (value.expirationTime != null && (typeof value.expirationTime !== "number" || !Number.isFinite(value.expirationTime) || value.expirationTime <= now)) throw new Error("Invalid push subscription.");
  const keys = value.keys as Record<string, unknown>;
  if (typeof keys.p256dh !== "string" || keys.p256dh.length !== 87 || typeof keys.auth !== "string" || keys.auth.length !== 22) throw new Error("Invalid push subscription.");
  const publicKey = decodeBase64url(keys.p256dh), auth = decodeBase64url(keys.auth);
  if (publicKey.length !== 65 || publicKey[0] !== 4 || auth.length !== 16) throw new Error("Invalid push subscription.");
  await crypto.subtle.importKey("raw", publicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
  return { endpoint: value.endpoint, expirationTime: value.expirationTime as number | null | undefined ?? null, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}
const copy: Record<PushKind, { title: string; body: string; path: string }> = {
  payment: { title: "Alfred", body: "There’s a private update for you. Open Alfred to review.", path: "/chat" },
  bill: { title: "Alfred", body: "A private reminder is ready. Open Alfred to review.", path: "/dashboard" },
  weekly: { title: "Alfred", body: "Your private overview is ready. Open Alfred to review.", path: "/dashboard" },
  test: { title: "Alfred", body: "This is a test notification from Alfred.", path: "/settings" },
};
/** Fixed private copy; the optional opaque locator is resolved under the signed-in owner. */
export function notificationPayload(kind: PushKind, targetId?: string) {
  if (!Object.hasOwn(copy, kind)) throw new Error("Invalid notification kind.");
  const selected = copy[kind];
  const target = targetId === undefined ? null : paymentTargetId(targetId);
  if (targetId !== undefined && (kind !== 'payment' || !target)) throw new Error('Invalid payment target.');
  const path = target ? `/accounts?payment=${target}` : selected.path;
  return {
    web_push: 8030,
    kind,
    ...(target ? { targetId: target } : {}),
    notification: { title: selected.title, body: selected.body, navigate: DASHBOARD_URL + path, silent: false },
  };
}
async function hkdf(input: Bytes, salt: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", input, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}
export async function encryptedBody(subscription: PushSubscriptionRecord, payload: ReturnType<typeof notificationPayload>): Promise<Bytes> {
  const recipient = decodeBase64url(subscription.keys.p256dh), auth = decodeBase64url(subscription.keys.auth);
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const sender = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const recipientKey = await crypto.subtle.importKey("raw", recipient, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: recipientKey }, pair.privateKey, 256));
  const ikm = await hkdf(shared, auth, concat(encoder.encode("WebPush: info\0"), recipient, sender), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, salt, encoder.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plain = concat(encoder.encode(JSON.stringify(payload)), new Uint8Array([2]));
  if (plain.length + 16 >= 4096) throw new Error("Push payload too large.");
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain));
  return concat(salt, new Uint8Array([0, 0, 16, 0, sender.length]), sender, encrypted);
}
export async function authorization(endpoint: string, config: PushConfiguration, now = Date.now()): Promise<string> {
  if (!endpointAllowed(endpoint) || !subjectAllowed(config.subject)) throw new Error("Invalid push configuration.");
  const publicKey = decodeBase64url(config.publicKey), privateKey = decodeBase64url(config.privateKey);
  if (publicKey.length !== 65 || publicKey[0] !== 4 || privateKey.length !== 32) throw new Error("Invalid push configuration.");
  const key = await crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256", x: base64url(publicKey.slice(1, 33)), y: base64url(publicKey.slice(33)), d: base64url(privateKey),
  }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const unsigned = base64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" }))) + "." +
    base64url(encoder.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 43_200, sub: config.subject })));
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(unsigned));
  return `vapid t=${unsigned}.${base64url(signature)}, k=${config.publicKey}`;
}
export type PushFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export async function sendWebPush(
  subscription: PushSubscriptionRecord, config: PushConfiguration, kind: PushKind, fetcher: PushFetcher = fetch, targetId?: string,
): Promise<Response> {
  let auth: string, body: Bytes;
  try { auth = await authorization(subscription.endpoint, config); } catch { throw new PushFailure("authorization"); }
  try { body = await encryptedBody(subscription, notificationPayload(kind, targetId)); } catch { throw new PushFailure("encryption"); }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetcher(subscription.endpoint, {
      method: "POST", redirect: "manual", signal: controller.signal,
      headers: { Authorization: auth, "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "60", Urgency: "normal" },
      body,
    });
  } catch { throw new PushFailure("connection"); }
  finally { clearTimeout(timer); }
}
