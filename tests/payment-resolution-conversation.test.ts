import { describe, expect, it, vi } from "vitest";
import { MemoryMessageLog } from "@/lib/accounts/messages";
import type { BankMessage } from "@/lib/bank/store";
import { answerPaymentResolution } from "@/lib/bank/payment-resolution-conversation";
import type { PaymentResolutionContext, PaymentResolutionDeps } from "@/lib/bank/payment-resolutions";

const OWNER="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",BANK="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",RETURN="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const source:BankMessage={id:BANK,ownerId:OWNER,source:"momo",channel:"mac",externalId:"fictional",direction:"out",kind:"payment",amount:"100.00",fee:"0.25",currency:"GHS",counterparty:"FICTIONAL PERSON",balance:"200.00",occurredAt:"2026-11-04T10:00:00Z",status:"needs_label",transactionId:null,feeTransactionId:null,askedAt:null,raw:"Fictional source fixture",readBy:"rules"};
const original={id:"bank:original",fingerprint:"original-fingerprint",amountMinor:10000,remainingMinor:10000,date:"2026-11-01",description:"Fictional original purchase",currency:"GHS"};
function setup(patch:Partial<PaymentResolutionContext>={}){
  const current:PaymentResolutionContext={ownerId:OWNER,bankMessageId:BANK,source:{...source},availability:"ready",noMoneyAllowed:true,returnAllowed:false,originals:[],returns:[],resolved:null,evidenceFingerprint:"a".repeat(64),...patch};
  const service:PaymentResolutionDeps={inspect:vi.fn(async()=>current),noMoney:vi.fn(async()=>({status:"saved" as const,changed:true})),returned:vi.fn(async()=>({status:"saved" as const,changed:true})),reopen:vi.fn(async()=>({status:"saved" as const,changed:true}))};
  const messages=new MemoryMessageLog();
  const answer=(text:string,clientId="resolution-fixture-answer")=>answerPaymentResolution({text,ownerId:OWNER,focus:{bankMessageId:BANK,requiresPurpose:true},clientId,messages,service});
  const save=async(reply:Awaited<ReturnType<typeof answer>>)=>messages.append({ownerId:OWNER,role:"assistant",channel:"web",body:reply!.text,intent:reply?.intent,paymentNotice:reply?.paymentNotice});
  return {current,service,messages,answer,save};
}

describe("explicit payment exceptions in chat",()=>{
  it.each(["it failed","no money moved","the payment didn't complete"])("requires the exact saved no-money confirmation for %s",async text=>{
    const state=setup();const first=await state.answer(text);
    expect(first?.text).toContain("outgoing alert for GH₵100.00");
    expect(first?.text).toContain("If money left and then came back");
    expect(state.service.noMoney).not.toHaveBeenCalled();
    await state.save(first);const confirmed=await state.answer("yes","resolution-fixture-confirm");
    expect(confirmed?.text).toContain("You confirmed that no money moved");
    expect(confirmed?.paymentNotice?.requiresPurpose).toBe(false);
    expect(state.service.noMoney).toHaveBeenCalledWith(OWNER,BANK,expect.objectContaining({requestId:"resolution-fixture-confirm",evidenceFingerprint:"a".repeat(64),reason:text==="it failed"?"failed":"not_completed"}));
  });
  it("never takes yes to another question, a stale proof or an owner mismatch as permission",async()=>{
    const state=setup();expect(await state.answer("yes")).toBeNull();
    const question=await state.answer("it failed");await state.save(question);
    state.current.evidenceFingerprint="b".repeat(64);
    expect((await state.answer("yes"))?.text).toContain("records changed");
    expect(state.service.noMoney).not.toHaveBeenCalled();
    state.current.ownerId="another-owner";expect(await state.answer("it failed")).toBeNull();
  });
  it("protects classified movements and does not exclude a completed test transfer",async()=>{
    const state=setup({noMoneyAllowed:false,source:{...source,status:"recorded",transactionId:"recorded-ledger"}});
    expect((await state.answer("it failed"))?.text).toContain("already has a classification");
    expect(state.service.noMoney).not.toHaveBeenCalled();
    expect(await state.answer("It was a completed test transfer from my Hubtel to MTN MoMo")).toBeNull();
  });
  it("does not use a bare status to claim that an edited resolution is still excluded",async()=>{
    const state=setup({source:{...source,status:"not_completed"},resolved:"not_completed",noMoneyAllowed:false,resolutionNotice:"This payment's saved resolution needs checking because its classification changed."});
    expect((await state.answer("it failed"))?.text).toContain("needs checking");
    expect((await state.answer("it failed"))?.text).not.toContain("It is excluded");
    expect(state.service.noMoney).not.toHaveBeenCalled();
  });
  it("asks principal and original instead of assuming a full refund, then accepts the natural follow-up",async()=>{
    const state=setup({source:{...source,direction:"in",amount:"25.00"},returnAllowed:true,originals:[original],returns:[{bankMessageId:BANK,amountMinor:2500,date:"2026-11-04",description:"Fictional return",fingerprint:"return-proof"}]});
    const ask=await state.answer("this was refunded");expect(ask?.text).toContain("How much principal came back");expect(state.service.returned).not.toHaveBeenCalled();
    await state.save(ask);const proposal=await state.answer("25 from the 100 payment on 2026-11-01","resolution-return-selection");
    expect(proposal?.text).toContain("link GH₵25.00");expect(proposal?.text).toContain("GH₵100.00 payment on 2026-11-01");
    await state.save(proposal);const saved=await state.answer("yes","resolution-return-confirm");
    expect(saved?.text).toContain("rather than new income");
    expect(state.service.returned).toHaveBeenCalledWith(OWNER,BANK,{requestId:"resolution-return-confirm",evidenceFingerprint:"a".repeat(64),originalId:original.id,returnBankMessageId:BANK,principalMinor:2500});
  });
  it("guides the outgoing notification to the actual incoming return through chat",async()=>{
    const state=setup({source:{...source,status:"recorded"},noMoneyAllowed:false,returnAllowed:true,originals:[original],returns:[{bankMessageId:RETURN,amountMinor:2500,date:"2026-11-04",description:"Fictional return",fingerprint:"return-proof"}]});
    const ask=await state.answer("this was reversed");expect(ask?.text).toContain("Possible incoming returns: GH₵25.00");
    const proposal=await state.answer("25 returned from the 100 payment on 2026-11-01");await state.save(proposal);
    await state.answer("yes","outgoing-return-confirm");
    expect(state.service.returned).toHaveBeenCalledWith(OWNER,BANK,expect.objectContaining({returnBankMessageId:RETURN,principalMinor:2500,originalId:original.id}));
  });
  it("does not select among equal original payments or silently discard an unexplained remainder",async()=>{
    const state=setup({source:{...source,direction:"in",amount:"30.00"},returnAllowed:true,originals:[original,{...original,id:"bank:other"}],returns:[{bankMessageId:BANK,amountMinor:3000,date:"2026-11-04",description:"Fictional return",fingerprint:"return-proof"}]});
    expect((await state.answer("30 returned from the 100 payment on 2026-11-01"))?.text).toContain("How much principal");
    state.current.originals=[original];
    expect((await state.answer("25 returned from the 100 payment on 2026-11-01"))?.text).toContain("How much principal");
    expect(state.service.returned).not.toHaveBeenCalled();
  });
  it("does not invite a bare expense category for an incoming return whose original is unclassified",async()=>{
    const state=setup({source:{...source,direction:"in",amount:"25.00"},originals:[]});
    const reply=await state.answer("25 was returned");
    expect(reply?.text).toContain("Open its own earlier message or notification in Chat");
    expect(reply?.text).toContain("Don't label this credit as spending or new income");
    expect(state.service.returned).not.toHaveBeenCalled();
  });
  it.each(["not_completed","returned"] as const)("can ask to reopen a %s resolution and waits for confirmation",async resolved=>{
    const state=setup({source:{...source,status:resolved},resolved,noMoneyAllowed:false});
    const question=await state.answer(resolved==="not_completed"?"actually, the payment did complete":"undo this refund");
    expect(question?.text).toMatch(/Should I (?:reopen|unlink)/);expect(state.service.reopen).not.toHaveBeenCalled();
    await state.save(question);const saved=await state.answer("yes","resolution-reopen-confirm");
    expect(saved?.text).toContain("I've reopened this payment");expect(saved?.paymentNotice?.requiresPurpose).toBe(true);
    expect(state.service.reopen).toHaveBeenCalledWith(OWNER,BANK,{requestId:"resolution-reopen-confirm",evidenceFingerprint:"a".repeat(64)});
  });
  it("does not claim success after a stale or uncertain write",async()=>{
    const state=setup();const question=await state.answer("it failed");await state.save(question);
    vi.mocked(state.service.noMoney).mockResolvedValueOnce({status:"stale",changed:false});
    expect((await state.answer("yes"))?.text).toContain("haven't confirmed a change");
    vi.mocked(state.service.noMoney).mockRejectedValueOnce(new Error("Synthetic uncertain commit"));
    expect((await state.answer("yes"))?.text).toContain("couldn't confirm whether");
  });
});
