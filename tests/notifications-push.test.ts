import { createECDH, createDecipheriv, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { authorization, encryptedBody, endpointAllowed, notificationPayload, PushFailure, pushConfiguration, sendWebPush, validateSubscription, type PushConfiguration, type PushSubscriptionRecord } from "@/lib/notifications/push";

function fixture() {
  const client = createECDH("prime256v1"); client.generateKeys();
  return { client, subscription: {
    endpoint: "https://web.push.apple.com/synthetic-no-send", expirationTime: null,
    keys: { p256dh: client.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
  } satisfies PushSubscriptionRecord };
}
function vapid(): PushConfiguration {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.privateKey.export({ format: "jwk" });
  return { publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url"), privateKey: jwk.d!, subject: "mailto:synthetic@example.invalid" };
}
function decrypt(body: Uint8Array, value: ReturnType<typeof fixture>) {
  const bytes = Buffer.from(body), salt = bytes.subarray(0, 16), sender = bytes.subarray(21, 21 + bytes[20]), ciphertext = bytes.subarray(21 + bytes[20]);
  expect(bytes.readUInt32BE(16)).toBe(4096); expect(sender.length).toBe(65);
  const shared = value.client.computeSecret(sender), recipient = value.client.getPublicKey();
  const ikm = Buffer.from(hkdfSync("sha256", shared, Buffer.from(value.subscription.keys.auth, "base64url"), Buffer.concat([Buffer.from("WebPush: info\0"), recipient, sender]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16)), nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce); decipher.setAuthTag(ciphertext.subarray(-16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  expect(plain.at(-1)).toBe(2); return JSON.parse(plain.subarray(0, -1).toString());
}
describe("private Web Push transport", () => {
  it("encrypts payloads interoperably with independent Node crypto", async () => {
    const f = fixture(); const payload = notificationPayload("payment");
    expect(decrypt(await encryptedBody(f.subscription, payload), f)).toEqual(payload);
    expect(decrypt(await encryptedBody(f.subscription, notificationPayload("bill")), f)).toEqual(notificationPayload("bill"));
  });
  it("signs VAPID for only the provider origin with a bounded expiry", async () => {
    const cfg = vapid(), now = Date.now();
    const header = await authorization("https://web.push.apple.com/synthetic", cfg, now);
    const token = header.match(/^vapid t=(.+), k=/)![1], [h,p,s] = token.split("."), pub = Buffer.from(cfg.publicKey,"base64url");
    expect(verify("sha256", Buffer.from(h+"."+p), { key:createPublicKey({ key:{kty:"EC",crv:"P-256",x:pub.subarray(1,33).toString("base64url"),y:pub.subarray(33).toString("base64url")},format:"jwk"}), dsaEncoding:"ieee-p1363" }, Buffer.from(s,"base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(p,"base64url").toString())).toEqual({ aud:"https://web.push.apple.com",exp:Math.floor(now/1000)+43200,sub:cfg.subject });
  });
  it("has no default deployment keys and returns no partial private configuration", () => {
    expect(pushConfiguration({})).toEqual({ready:false,publicKey:null,config:null});
    const c=vapid(); expect(pushConfiguration({VAPID_PUBLIC_KEY:c.publicKey,VAPID_PRIVATE_KEY:c.privateKey,VAPID_SUBJECT:c.subject}).ready).toBe(true);
    expect(pushConfiguration({VAPID_PUBLIC_KEY:c.publicKey,VAPID_PRIVATE_KEY:c.privateKey,VAPID_SUBJECT:"javascript:alert(1)"})).toEqual({ready:false,publicKey:null,config:null});
  });
  it("allows only recognized HTTPS push endpoints", () => {
    for(const endpoint of ["https://web.push.apple.com/synthetic","https://fcm.googleapis.com/fcm/send/synthetic","https://updates.push.services.mozilla.com/wpush/v2/synthetic"])expect(endpointAllowed(endpoint)).toBe(true);
    for(const endpoint of ["https://localhost/x","https://127.0.0.1/x","https://169.254.169.254/x","https://web.push.apple.com.evil.invalid/x","https://fcm.googleapis.com.evil.invalid/x","https://web.push.apple.com:444/x","https://web.push.apple.com:443/x"," https://web.push.apple.com/x","https://name:secret@web.push.apple.com/x","http://web.push.apple.com/x","https://web.push.apple.com/x#private","https://web.push.apple.com/"])expect(endpointAllowed(endpoint)).toBe(false);
  });
  it("validates expiry, public point and authentication key", async () => {
    const f=fixture(); expect(await validateSubscription(f.subscription)).toEqual(f.subscription);
    for(const bad of [null,[],{...f.subscription,endpoint:"https://example.invalid/x"},{...f.subscription,expirationTime:1},{...f.subscription,expirationTime:Infinity},{...f.subscription,keys:{...f.subscription.keys,p256dh:"bad"}},{...f.subscription,keys:{...f.subscription.keys,auth:"bad"}},{...f.subscription,keys:{...f.subscription.keys,p256dh:Buffer.concat([Buffer.from([4]),Buffer.alloc(64)]).toString("base64url")}}])await expect(validateSubscription(bad)).rejects.toThrow();
  });
  it("constructs only fixed discreet payloads with no payment targets", () => {
    for(const kind of ["payment","bill","weekly"] as const) {
      const payload=notificationPayload(kind), serialized=JSON.stringify(payload);
      expect(payload.notification.title).toBe("Alfred");
      expect(serialized).not.toMatch(/GHS|merchant|amount|sender|transactionId|bankMessage|eventId|token|\?/);
      expect(new URL(payload.notification.navigate).origin).toBe("https://alfred.hansopoku.com");
    }
  });
  it("uses encrypted fake transport with redirects disabled and no raw private details", async () => {
    const f=fixture(),cfg=vapid();let calls=0;
    const response=await sendWebPush(f.subscription,cfg,"payment",async (url,options)=>{
      calls++;expect(url).toBe(f.subscription.endpoint);expect(options?.redirect).toBe("manual");
      expect((options?.headers as Record<string,string>)["Content-Encoding"]).toBe("aes128gcm");
      expect(decrypt(options!.body as Uint8Array,f)).toEqual(notificationPayload("payment"));
      return new Response(null,{status:201});
    });
    expect(response.status).toBe(201);expect(calls).toBe(1);
  });
  it("marks connection exceptions as ambiguous and strips their details", async () => {
    const f=fixture();
    try { await sendWebPush(f.subscription,vapid(),"payment",async()=>{throw new Error("private endpoint and payment body")});throw new Error("expected failure"); }
    catch(error){expect(error).toBeInstanceOf(PushFailure);expect((error as PushFailure).stage).toBe("connection");expect(String(error)).not.toContain("private");}
  });
  it("never attempts network if destination or VAPID configuration is invalid", async () => {
    let calls=0;const fake=async()=>{calls++;return new Response(null,{status:201});};
    await expect(sendWebPush({...fixture().subscription,endpoint:"https://example.invalid/"},vapid(),"payment",fake)).rejects.toMatchObject({stage:"authorization"});
    await expect(sendWebPush(fixture().subscription,{...vapid(),privateKey:"bad"},"payment",fake)).rejects.toMatchObject({stage:"authorization"});
    expect(calls).toBe(0);
  });
});

describe("notification-only service worker",()=>{
  it("ignores arbitrary push text and cross-origin links and never caches financial data",async()=>{
    const source=await readFile(new URL("../public/alfred-push-sw.js",import.meta.url),"utf8");
    const handlers=new Map<string,(event:unknown)=>void>();const shown:unknown[]=[];const opened:string[]=[];let done:Promise<unknown>|undefined;
    const worker={location:{origin:"https://alfred.hansopoku.com"},skipWaiting:async()=>{},registration:{showNotification:async(title:string,options:unknown)=>{shown.push({title,options});}},clients:{claim:async()=>{},matchAll:async()=>[],openWindow:async(url:string)=>{opened.push(url);}},addEventListener:(name:string,fn:(event:unknown)=>void)=>handlers.set(name,fn)};
    vm.runInNewContext(source,{self:worker,URL,Object});
    handlers.get("push")!({data:{json:()=>({kind:"payment",notification:{title:"GHS 900 from private sender",body:"private SMS",navigate:"https://evil.invalid/"}})},waitUntil:(p:Promise<unknown>)=>{done=p;}});
    await done;expect(JSON.stringify(shown)).not.toMatch(/GHS|private sender|private SMS|evil/);
    handlers.get("notificationclick")!({notification:{close:()=>{},data:{kind:"https://evil.invalid/"}},waitUntil:(p:Promise<unknown>)=>{done=p;}});
    await done;expect(opened).toEqual(["https://alfred.hansopoku.com/chat"]);
    expect(handlers.has("fetch")).toBe(false);expect(source).not.toContain("caches.");
  });
});
