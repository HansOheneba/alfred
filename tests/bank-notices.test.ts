import {describe,expect,it} from 'vitest';
import {incomingPaymentMention,mentionEligible,writePaymentMentions,type MentionCandidate} from '@/lib/bank/notices';
import {DEFAULT_NOTIFICATION_PREFERENCES} from '@/lib/notifications/store';
import type {StoredPaymentPurpose} from '@/lib/bank/purpose';
const now=new Date('2026-11-03T12:00:00.000Z');
const prefs={...DEFAULT_NOTIFICATION_PREFERENCES,paymentMentions:true,paymentMentionsSince:'2026-11-03T11:00:00.000Z'};
const principal='22222222-2222-4222-8222-222222222222';
const purpose=(patch:Partial<StoredPaymentPurpose>={}):StoredPaymentPurpose=>({ownerId:'owner-a',transactionId:principal,category:'Salary',description:'November salary',recordStatus:'active',...patch});
const row=(patch:Partial<MentionCandidate>={}):MentionCandidate=>({id:'11111111-1111-4111-8111-111111111111',ownerId:'owner-a',channel:'mac',direction:'in',kind:'payment',amount:'250.00',currency:'GHS',counterparty:'Sample Sender',occurredAt:'2026-11-03T11:30:00.000Z',createdAt:'2026-11-03T11:31:00.000Z',status:'recorded',transactionId:principal,feeTransactionId:null,readBy:'rules',purpose:null,...patch});
describe('purpose-aware private payment mentions',()=>{
 it('acknowledges purpose from the owned active principal without claiming settlement',()=>{
  const notice=incomingPaymentMention(row({purpose:purpose()}))!;
  expect(notice.body).toContain('for November salary');expect(notice.body).toContain('filed it under Salary');expect(notice.body).toContain('Sample Sender');
  expect(notice.body).not.toMatch(/what was|verified|settled|bank confirmed/i);
  expect(notice).toMatchObject({requiresPurpose:false,ledgerChanged:true,intent:'automation:incoming-payment'});
 });
 it('acknowledges a meaningful category without inventing a specific purpose',()=>{
  const notice=incomingPaymentMention(row({purpose:purpose({description:''})}))!;
  expect(notice.body).toContain("It's filed under Salary");expect(notice.body).not.toContain('November');expect(notice.requiresPurpose).toBe(false);
 });
 it.each([{ownerId:'owner-b'},{transactionId:'33333333-3333-4333-8333-333333333333'},{recordStatus:'void'}])('does not borrow purpose from mismatched or inactive records %j',patch=>{
  const notice=incomingPaymentMention(row({purpose:purpose(patch)}))!;
  expect(notice.body).not.toMatch(/November salary|filed.*Salary/);expect(notice.body).toContain("linked record doesn't explain its purpose");expect(notice.requiresPurpose).toBe(false);
 });
 it('never treats a classified fee as the principal purpose',()=>{
  const fee='33333333-3333-4333-8333-333333333333';
  const notice=incomingPaymentMention(row({feeTransactionId:fee,purpose:purpose({transactionId:fee,category:'Fees',description:'Provider fee'})}))!;
  expect(notice.body).not.toMatch(/for Provider fee|under Fees/);expect(notice.body).toContain("doesn't explain its purpose");
 });
 it('asks about an unlabelled incoming payment even from a recognized provider',()=>{
  const notice=incomingPaymentMention(row({status:'needs_label',transactionId:null,counterparty:'MobileMoney',readBy:'rules'}))!;
  expect(notice.body).toContain('incoming payment alert for GH₵250.00 from MobileMoney');expect(notice.body).toContain('What was this for?');expect(notice.body).toContain("leave it unlabelled");
  expect(notice).toMatchObject({requiresPurpose:true,ledgerChanged:false});
 });
 it('preserves fee refresh metadata while leaving principal purpose unknown',()=>{
  const notice=incomingPaymentMention(row({status:'needs_label',transactionId:null,feeTransactionId:'33333333-3333-4333-8333-333333333333'}))!;
  expect(notice).toMatchObject({requiresPurpose:true,ledgerChanged:true});expect(notice.body).toContain('What was this for?');
 });
 it.each([['Other',''],['Misc',''],['Other','From Sample Sender'],['Other','Payment received'],['Misc','Sample Sender']])('does not claim vague %s / %s is a known purpose', (category,description)=>{
  const notice=incomingPaymentMention(row({purpose:purpose({category,description})}))!;
  expect(notice.body).toContain("linked record doesn't explain its purpose");expect(notice.body).not.toContain("I've filed it");
  // A settled row requires correction, not a new label operation/duplicate entry.
  expect(notice.requiresPurpose).toBe(false);expect(notice.body).toContain('What was this for?');expect(notice.body).toContain('Review before making a correction');
 });
 it('can acknowledge a specific persisted description even under Other',()=>{
  const notice=incomingPaymentMention(row({purpose:purpose({category:'Other',description:'November club dues'})}))!;
  expect(notice.body).toContain('for November club dues');expect(notice.body).toContain('under Other');expect(notice.requiresPurpose).toBe(false);
 });
 it.each([{readBy:'model'},{kind:'unknown'}] as Partial<MentionCandidate>[])('does not overstate uncertain classification %j',patch=>{
  const held=incomingPaymentMention(row({...patch,status:'needs_label',transactionId:null}))!;
  expect(held.body).toContain('possible incoming payment alert');expect(held.body).toContain('check that it looks right');expect(held.body).toContain('what it was for');expect(held.requiresPurpose).toBe(true);
  const settled=incomingPaymentMention(row({...patch,purpose:purpose()}))!;
  expect(settled.body).toContain('Please check the linked record');expect(settled.body).not.toContain('filed it under');expect(settled.requiresPurpose).toBe(false);
 });
 it('describes an existing match without counting it again or relabelling it',()=>{
  const known=incomingPaymentMention(row({status:'matched',purpose:purpose()}))!;
  expect(known.body).toContain('looks like your November salary entry');expect(known.body).toContain("only counted once");expect(known).toMatchObject({ledgerChanged:false,requiresPurpose:false});
  const unknown=incomingPaymentMention(row({status:'matched'}))!;
  expect(unknown.body).toContain("I won't guess its purpose");expect(unknown.requiresPurpose).toBe(false);
 });
 it.each(['needs_label','recorded','matched'] as const)('keeps incoming direction explicit for %s with or without known purpose',status=>{
  for(const savedPurpose of [null,purpose()]){
   const notice=incomingPaymentMention(row({status,transactionId:status==='needs_label'?null:principal,purpose:savedPurpose}))!;
   expect(notice.body).toContain('incoming payment alert for GH₵250.00');
   expect(notice.body).not.toMatch(/outgoing|money-out|settled|bank confirmed/);
  }
 });
 it.each([{direction:'out'},{kind:'transfer_own'},{kind:'loan_in'},{status:'skipped'},{status:'invested'},{amount:'0.00'},{amount:'NaN'},{channel:'manual'},{channel:'screenshot'},{status:'matched',transactionId:null},{status:'recorded',transactionId:null}] as Partial<MentionCandidate>[])('excludes notices that cannot be safely acted on %j',patch=>{expect(incomingPaymentMention(row(patch))).toBeNull();});
 it('uses stable owner-and-event idempotency, never raw source text',()=>{
  const candidate={...row(),raw:'PRIVATE_SYNTHETIC_SMS_CANARY'};
  const first=incomingPaymentMention(candidate)!,again=incomingPaymentMention(candidate)!;
  expect(first.clientId).toBe(again.clientId);expect(first.clientId).not.toBe(incomingPaymentMention(row({ownerId:'owner-b'}))?.clientId);
  expect(first.clientId).toMatch(/^bank_notice_[a-f0-9]{64}$/);expect(first.clientId.length).toBeLessThanOrEqual(80);expect(first.body).not.toContain(candidate.raw);
 });
 it('requires opt-in, owner match, activation fence and fresh detection',()=>{
  expect(mentionEligible(row(),'owner-a',prefs,now)).toBe(true);
  for(const candidate of [row({ownerId:'owner-b'}),row({occurredAt:'2026-11-03T10:59:00Z'}),row({createdAt:'2026-11-03T10:59:00Z'}),row({occurredAt:'2026-11-03T13:00:00Z'}),row({createdAt:'2026-11-03T13:00:00Z'})])expect(mentionEligible(candidate,'owner-a',prefs,now)).toBe(false);
  expect(mentionEligible(row(),'owner-a',DEFAULT_NOTIFICATION_PREFERENCES,now)).toBe(false);
 });
 it('recovers after a failed save and does not repeat speech after a saved receipt',async()=>{
  const saved=new Map<string,string>();let failed=true;
  const save=async(_message:MentionCandidate,notice:NonNullable<ReturnType<typeof incomingPaymentMention>>)=>{if(failed){failed=false;throw Error('synthetic unavailable');}if(saved.has(notice.clientId))return false;saved.set(notice.clientId,notice.body);return true;};
  await expect(writePaymentMentions('owner-a',prefs,[row()],now,save)).rejects.toThrow('synthetic');
  expect(await writePaymentMentions('owner-a',prefs,[row(),row()],now,save)).toBe(1);
  expect(await writePaymentMentions('owner-a',prefs,[row()],now,save)).toBe(0);expect(saved.size).toBe(1);
 });
});
