import { createECDH, createDecipheriv, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { authorization, encryptedBody, endpointAllowed, notificationPayload, PushFailure, pushConfiguration, sendWebPush, validateSubscription, type PushConfiguration, type PushSubscriptionRecord } from "@/lib/notifications/push";
import { paymentPushBody, paymentPushDetails } from "@/lib/notifications/payment-copy";

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
    for(const kind of ["payment","bill","weekly","test"] as const) {
      const payload=notificationPayload(kind), serialized=JSON.stringify(payload);
      expect(payload.notification.title).toBe("Alfred");
      expect(serialized).not.toMatch(/GHS|merchant|amount|sender|transactionId|bankMessage|eventId|token|\?/);
      expect(new URL(payload.notification.navigate).origin).toBe("https://alfred.hansopoku.com");
    }
  });
  it('allows only a canonical opaque payment locator, with no financial details or caller URL', () => {
    const id='11111111-1111-4111-8111-111111111111';
    const payload=notificationPayload('payment',id);
    expect(payload.targetId).toBe(id);
    expect(payload.notification.navigate).toBe('https://alfred.hansopoku.com/chat?payment='+id);
    expect(payload.notification.body).toBe(notificationPayload('payment').notification.body);
    for(const target of ['',id.toUpperCase().replace('11111111','AAAAAAAA'),id+'?next=https://evil.invalid','https://evil.invalid/',`bank:${id}`])expect(()=>notificationPayload('payment',target)).toThrow('Invalid payment target');
    for(const kind of ['test','bill','weekly'] as const)expect(()=>notificationPayload(kind,id)).toThrow('Invalid payment target');
    expect(()=>notificationPayload('constructor' as 'payment')).toThrow('Invalid notification kind');
  });
  it('formats only structured payment amounts and validated transfer labels', () => {
    const id='11111111-1111-4111-8111-111111111111';
    for(const amount of ['0.01','0.50','1.00','10000.15']){
      const details={amount,currency:'GHS',direction:'in' as const};
      const payload=notificationPayload('payment',id,details);
      expect(payload.payment).toEqual(details);
      expect(payload.notification.body).toBe(paymentPushBody(details));
      expect(payload.notification.body).toContain(amount==='10000.15'?'GH₵10,000.15':'GH₵'+amount);
      expect(payload.notification.navigate).toBe('https://alfred.hansopoku.com/chat?payment='+id);
    }
    expect(paymentPushBody({amount:'1',currency:'USD',direction:'out'})).toBe('Money out · −USD 1.00. Open Alfred to chat.');
    expect(paymentPushBody({amount:'1.00',currency:'GHS',direction:'out',transfer:{fromAccount:'Hubtel wallet',toAccount:'MTN MoMo'}})).toBe('Transfer · GH₵1.00 · Hubtel wallet → MTN MoMo.');
    expect(paymentPushBody({amount:'1.00',currency:'GHS',direction:'in',transfer:{}})).toBe('Transfer · GH₵1.00 between your accounts.');
    for(const amount of ['0','0.00','-1.00','1e2','1.001','Infinity','NaN','01.00','99999999999.99'])expect(paymentPushDetails({amount,currency:'GHS',direction:'in'})).toBeNull();
    for(const currency of ['ghs','GH₵','GHS\n'])expect(paymentPushDetails({amount:'1',currency,direction:'in'})).toBeNull();
    expect(paymentPushDetails({amount:'1',currency:'GHS',direction:'out',transfer:{fromAccount:'x\nPRIVATE',toAccount:'MTN'}})?.transfer).toEqual({});
    for(const kind of ['test','bill','weekly'] as const)expect(()=>notificationPayload(kind,undefined,{amount:'1',currency:'GHS',direction:'in'})).toThrow('Invalid payment details');
    expect(()=>notificationPayload('payment',undefined,{amount:'1',currency:'GHS',direction:'in'})).toThrow('Invalid payment details');
  });
  it('encrypts the validated target and fixed explicit-test copy using fake transport only', async () => {
    const f=fixture(),cfg=vapid(),target='11111111-1111-4111-8111-111111111111';
    let calls=0;
    const fake=async (_url:unknown,options?:RequestInit)=>{calls++;const payload=decrypt(options!.body as Uint8Array,f);expect(payload).toEqual(notificationPayload(payload.kind,payload.targetId,payload.payment));return new Response(null,{status:201});};
    await sendWebPush(f.subscription,cfg,'payment',fake,target);
    await sendWebPush(f.subscription,cfg,'test',fake);
    await sendWebPush(f.subscription,cfg,'payment',fake,target,{amount:'0.50',currency:'GHS',direction:'out'});
    expect(calls).toBe(3);
    await expect(sendWebPush(f.subscription,cfg,'payment',fake,'https://evil.invalid')).rejects.toMatchObject({stage:'encryption'});
    expect(calls).toBe(3);
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
  it('opens the exact fixed payment path and replaces only retries of the same payment',async()=>{
    const source=await readFile(new URL('../public/alfred-push-sw.js',import.meta.url),'utf8');
    const handlers=new Map<string,(event:unknown)=>void>();
    const shown:{title:string;options:{body:string;data:{kind:string;targetId?:string};tag?:string}}[]=[];
    const opened:string[]=[];let done:Promise<unknown>|undefined;
    const worker={location:{origin:'https://alfred.hansopoku.com'},registration:{showNotification:async(title:string,options:typeof shown[number]['options'])=>{shown.push({title,options});}},clients:{matchAll:async()=>[],openWindow:async(url:string)=>{opened.push(url);}},addEventListener:(name:string,fn:(event:unknown)=>void)=>handlers.set(name,fn)};
    vm.runInNewContext(source,{self:worker,URL,Object});
    const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
    for(const targetId of [first,second,first]){handlers.get('push')!({data:{json:()=>({kind:'payment',targetId,notification:{navigate:'https://evil.invalid',body:'PRIVATE_FICTIONAL_DETAILS'}})},waitUntil:(p:Promise<unknown>)=>{done=p;}});await done;}
    expect(shown[0].options.tag).not.toBe(shown[1].options.tag);
    expect(shown[0].options.tag).toBe(shown[2].options.tag);
    expect(JSON.stringify(shown)).not.toMatch(/PRIVATE_FICTIONAL_DETAILS|evil/);
    for(const item of shown){handlers.get('notificationclick')!({notification:{close:()=>{},data:item.options.data},waitUntil:(p:Promise<unknown>)=>{done=p;}});await done;}
    expect(opened).toEqual([first,second,first].map(id=>'https://alfred.hansopoku.com/chat?payment='+id));
    for(const targetId of ['https://evil.invalid',first+'&owner=other',['bad']]){handlers.get('notificationclick')!({notification:{close:()=>{},data:{kind:'payment',targetId}},waitUntil:(p:Promise<unknown>)=>{done=p;}});await done;}
    expect(opened.slice(3)).toEqual(Array(3).fill('https://alfred.hansopoku.com/chat'));
    handlers.get('push')!({data:{json:()=>({kind:'test',targetId:first,body:'PRIVATE_FICTIONAL_DETAILS'})},waitUntil:(p:Promise<unknown>)=>{done=p;}});await done;
    expect(shown.at(-1)?.options).toMatchObject({body:'This is a test notification from Alfred.',data:{kind:'test'}});
    handlers.get('notificationclick')!({notification:{close:()=>{},data:shown.at(-1)!.options.data},waitUntil:(p:Promise<unknown>)=>{done=p;}});await done;
    expect(opened.at(-1)).toBe('https://alfred.hansopoku.com/settings');
  });
  it('shows only validated structured financial previews and keeps legacy or malformed payloads discreet',async()=>{
    const source=await readFile(new URL('../public/alfred-push-sw.js',import.meta.url),'utf8');
    const handlers=new Map<string,(event:unknown)=>void>();const shown:{body:string;data:unknown}[]=[];let done:Promise<unknown>|undefined;
    const worker={registration:{showNotification:async(_title:string,options:typeof shown[number])=>{shown.push(options);}},addEventListener:(name:string,fn:(event:unknown)=>void)=>handlers.set(name,fn)};
    vm.runInNewContext(source,{self:worker,URL,Object});
    const targetId='11111111-1111-4111-8111-111111111111';
    for(const payment of [
      {amount:'0.5',currency:'GHS',direction:'in'},
      {amount:'12345.67',currency:'USD',direction:'out'},
      {amount:'1.00',currency:'GHS',direction:'in',transfer:{fromAccount:'Hubtel wallet',toAccount:'MTN MoMo'}},
      {amount:'1',currency:'GHS',direction:'out',transfer:{fromAccount:'bad\nSMS',toAccount:'MoMo'}},
    ]){
      handlers.get('push')!({data:{json:()=>({kind:'payment',targetId,payment,notification:{body:'UNTRUSTED_RAW_SMS',navigate:'https://evil.invalid'}})},waitUntil:(p:Promise<unknown>)=>{done=p;}});await done;
      expect(shown.at(-1)?.body).toBe(paymentPushBody(payment as Parameters<typeof paymentPushBody>[0]));
      expect(JSON.stringify(shown.at(-1)?.data)).not.toMatch(/amount|currency|Hubtel/);
    }
    for(const payment of [undefined,{amount:'-1',currency:'GHS',direction:'in'},{amount:'1.001',currency:'GHS',direction:'in'},{amount:'1',currency:'GHS\nPRIVATE',direction:'in'}]){
      handlers.get('push')!({data:{json:()=>({kind:'payment',targetId,payment})},waitUntil:(p:Promise<unknown>)=>{done=p;}});await done;
      expect(shown.at(-1)?.body).toBe(notificationPayload('payment').notification.body);
    }
    handlers.get('push')!({data:{json:()=>({kind:'test',targetId,payment:{amount:'1',currency:'GHS',direction:'in'}})},waitUntil:(p:Promise<unknown>)=>{done=p;}});await done;
    expect(shown.at(-1)?.body).toBe('This is a test notification from Alfred.');
    expect(JSON.stringify(shown)).not.toMatch(/UNTRUSTED_RAW_SMS|evil|bad\\nSMS/);
  });
});
