import { describe, expect, it } from 'vitest';
import { incomingPaymentMention, paymentActivityMention, mentionEligible, writePaymentMentions, type MentionCandidate } from '@/lib/bank/notices';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '@/lib/notifications/store';
import { isPaymentNoticeIntent } from '@/lib/accounts/messages';
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',id='11111111-1111-4111-8111-111111111111',txn='22222222-2222-4222-8222-222222222222';
const now=new Date('2026-11-03T12:00:00Z');
const prefs={...DEFAULT_NOTIFICATION_PREFERENCES,paymentMentions:true,paymentMentionsSince:'2026-11-03T11:00:00Z',outgoingMentions:true,outgoingMentionsSince:'2026-11-03T11:30:00Z'};
const row=(patch:Partial<MentionCandidate>={}):MentionCandidate=>({id,ownerId:owner,channel:'mac',direction:'out',kind:'payment',amount:'30.00',fee:'1.00',currency:'GHS',counterparty:'Synthetic shop',occurredAt:'2026-11-03T11:45:00Z',createdAt:'2026-11-03T11:46:00Z',status:'needs_label',transactionId:null,feeTransactionId:null,readBy:'rules',...patch});
const purpose={ownerId:owner,transactionId:txn,category:'Food',description:'Lunch',recordStatus:'active'};
describe('deterministic money-in and money-out announcements',()=>{
 it('announces an outgoing alert and its fee without recording or claiming settlement',()=>{
  const notice=paymentActivityMention(row())!;expect(notice.intent).toBe('automation:outgoing-payment');expect(notice.body).toContain('money-out alert to Synthetic shop');expect(notice.body).toContain('What was this for?');expect(notice.body).toContain('in fees');expect(notice.requiresPurpose).toBe(true);expect(notice.ledgerChanged).toBe(false);expect(notice.body).not.toMatch(/bank confirmed|settled|payment complete/i);
  expect(incomingPaymentMention(row())).toBeNull();
 });
 it('uses owned classification for an existing outgoing entry and does not count a match again',()=>{
  const notice=paymentActivityMention(row({status:'matched',transactionId:txn,purpose}))!;
  expect(notice.body).toContain('only counted once');expect(notice.body).toContain('Food');expect(notice.ledgerChanged).toBe(false);expect(notice.requiresPurpose).toBe(false);
 });
 it('describes a reduction in spending only from the matching owned negative-expense principal',()=>{
  const refund=row({direction:'in',status:'recorded',transactionId:txn,purpose:{...purpose,description:'Refund · Returned lunch'},principalType:'expense',principalAmount:'-30.00',principalCurrency:'GHS'});
  expect(paymentActivityMention(refund)?.body).toContain('reduces recorded spending rather than adding income');
  for(const patch of [{principalCurrency:'USD'},{principalType:'income'},{principalAmount:'30.00'},{principalAmount:'-20.00'},{purpose:{...purpose,ownerId:'foreign'}}])expect(paymentActivityMention({...refund,...patch})?.body).not.toContain('reduces recorded spending');
 });
 it.each([
  ['out','transfer_own','transfer','between your own accounts'],['in','loan_in','loan','possible loan-related'],['out','loan_out','lent','money you lent'],['in','loan_repay','repaid','loan repayment received'],['out','loan_repay','paid_back','loan repayment you made'],['out','payment','invested','investment movement'],['out','hold_settle','needs_label','before counting it again'],
 ] as const)('uses neutral classification for %s/%s/%s',(direction,kind,status,copy)=>{
  const notice=paymentActivityMention(row({direction,kind,status}))!;expect(notice.body).toContain(copy);expect(notice.requiresPurpose).toBe(false);expect(notice.body).not.toMatch(/filed.*(income|expense)|bank confirmed/i);
  expect(notice.ledgerChanged).toBe(['transfer','lent','borrowed','repaid','paid_back','invested'].includes(status));
 });
 it('does not mislabel a shared-bill contribution as a refund',()=>{
  const contribution=row({direction:'in',status:'recorded',transactionId:txn,purpose:{...purpose,description:"Fictional payer's share of lunch"},principalType:'expense',principalAmount:'-30.00',principalCurrency:'GHS'});
  const notice=paymentActivityMention(contribution)!;
  expect(notice.body).toContain('reduces recorded spending rather than adding income');expect(notice.body).not.toMatch(/refund|filed.*income/i);expect(notice.requiresPurpose).toBe(false);
 });
 it('keeps card holds provisional and unfamiliar model-read alerts uncertain',()=>{
  expect(paymentActivityMention(row({kind:'card_hold'}))?.body).toContain('card hold');
  expect(paymentActivityMention(row({readBy:'model'}))?.body).toContain('possible');
 });
 it('keeps independent activation/mute windows and excludes history/import channels',()=>{
  expect(mentionEligible(row(),owner,prefs,now)).toBe(true);
  expect(mentionEligible(row(),owner,{...prefs,outgoingMentions:false},now)).toBe(false);
  expect(mentionEligible(row({direction:'in'}),owner,{...prefs,outgoingMentions:false},now)).toBe(true);
  expect(mentionEligible(row({occurredAt:'2026-11-03T11:15:00Z'}),owner,prefs,now)).toBe(false);
  expect(mentionEligible(row({ownerId:'foreign'}),owner,prefs,now)).toBe(false);
  expect(paymentActivityMention(row({channel:'manual'}))).toBeNull();expect(paymentActivityMention(row({channel:'screenshot'}))).toBeNull();
  expect(paymentActivityMention(row({status:'skipped'}))).toBeNull();expect(paymentActivityMention(row({kind:'loan_out',status:'borrowed'}))).toBeNull();
 });
 it('uses one stable source receipt across retry, directions and multi-movement processing',async()=>{
  const inRow=row({direction:'in'}),outRow=row({id:'33333333-3333-4333-8333-333333333333'});
  expect(paymentActivityMention(inRow)?.clientId).toBe(paymentActivityMention(row())?.clientId);
  const receipts=new Set<string>();const save=async(_row:MentionCandidate,notice:NonNullable<ReturnType<typeof paymentActivityMention>>)=>{if(receipts.has(notice.clientId))return false;receipts.add(notice.clientId);return true;};
  expect(await writePaymentMentions(owner,prefs,[inRow,outRow,inRow],now,save)).toBe(2);expect(await writePaymentMentions(owner,prefs,[inRow,outRow],now,save)).toBe(0);
  expect(isPaymentNoticeIntent('automation:outgoing-payment')).toBe(true);expect(isPaymentNoticeIntent('create_transaction')).toBe(false);
 });
});
