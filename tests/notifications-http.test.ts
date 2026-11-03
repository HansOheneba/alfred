import { describe,expect,it } from "vitest";
import { notificationJSON,privateJSON,sameOrigin } from "@/lib/notifications/http";
const origin="https://alfred.example";
describe("notification request privacy boundary",()=>{
 it("requires exact same origin, rejecting missing, foreign and malformed origins",()=>{
  expect(sameOrigin(new Request(origin+"/api/notifications",{headers:{origin}}))).toBe(true);
  for(const source of ["https://evil.example","null",""]){expect(sameOrigin(new Request(origin+"/api/notifications",{headers:{origin:source}}))).toBe(false);}
 });
 it("reads bounded JSON only, rejecting content-type and streamed oversized bodies",async()=>{
  const request=(body:string,headers:Record<string,string>={"content-type":"application/json"})=>new Request(origin,{method:"POST",headers,body});
  expect(await notificationJSON(request('{"paymentPush":false}'))).toEqual({paymentPush:false});
  await expect(notificationJSON(request("{}",{"content-type":"text/plain"}))).rejects.toThrow("JSON");
  await expect(notificationJSON(request("x".repeat(4097)))).rejects.toThrow("too large");
  await expect(notificationJSON(request("not-json"))).rejects.toThrow("could not be read");
 });
 it("prevents cache reuse across signed-in accounts",()=>{
  const response=privateJSON({ok:true});expect(response.headers.get("cache-control")).toBe("private, no-store");expect(response.headers.get("vary")).toContain("Cookie");
 });
});
