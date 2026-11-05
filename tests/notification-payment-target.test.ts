import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyAccountingState, type AccountingState, type CashMovement } from '@/lib/finance/accounting/types';
import { ownedPaymentMovement, paymentTargetId, paymentTargetRequest } from '@/lib/notifications/payment-target';

const mocks=vi.hoisted(()=>({account:vi.fn(),load:vi.fn()}));
vi.mock('@/app/signed-in',()=>({publicAuthConfigured:()=>true,signedInAccount:mocks.account,MissingAuthConfig:()=>null}));
vi.mock('@/lib/finance/accounting/persisted-store',()=>({loadAccountingReadModel:mocks.load}));
vi.mock('@/app/components/app-shell',()=>({AppShell:({children}:{children:ReactNode})=>createElement('main',null,children),usePrivacyMask:()=>[false]}));
import AccountsPage from '@/app/accounts/page';

const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',target='11111111-1111-4111-8111-111111111111';
function state():AccountingState{return {...emptyAccountingState(owner),movements:[{id:'bank:'+target,ownerId:owner,accountId:null,direction:'out',status:'review',sourceStatus:'review',
  amountMinor:100,feeMinor:0,currency:'GHS',date:'2026-11-03',occurredAt:'2026-11-03T21:35:00Z',description:'Fictional selected payment',category:'Uncategorized',sourceCategory:'Uncategorized',
  sourceId:target,sourceKind:'bank',sourceFingerprint:'fictional-source',legacyTransactionId:null,feeTransactionId:null,legacyClassification:null} satisfies CashMovement]};}
beforeEach(()=>{vi.clearAllMocks();mocks.account.mockResolvedValue({kind:'ready',profile:{profileId:owner,preferredName:'Fictional',currency:'GHS'},settings:{supabase:{fixture:true}}});mocks.load.mockResolvedValue({state:state(),availability:'ready'});});
async function screen(payment:string|string[]){
  const boundary=AccountsPage({searchParams:Promise.resolve({payment})}) as ReactElement<{children:ReactElement}>;
  const child=boundary.props.children;
  return await (child.type as (props:unknown)=>Promise<ReactElement>)(child.props);
}

describe('authenticated payment locator resolution',()=>{
  it('accepts only one canonical UUID and never treats arbitrary links or repeated parameters as a target',()=>{
    expect(paymentTargetId(target)).toBe(target);
    expect(paymentTargetRequest(undefined)).toEqual({requested:false,id:null});
    for(const value of [null,'',target+'#private','https://evil.invalid',`bank:${target}`,[target,target]])expect(paymentTargetRequest(value)).toEqual({requested:true,id:null});
  });
  it('requires exact owned current bank identity, not amount, provider, description or a UUID alone',()=>{
    const saved=state();expect(ownedPaymentMovement(saved,owner,target)?.id).toBe('bank:'+target);
    expect(ownedPaymentMovement(saved,other,target)).toBeNull();
    for(const patch of [{ownerId:other},{sourceMissing:true},{sourceKind:'transaction' as const},{sourceId:'22222222-2222-4222-8222-222222222222'},{id:'transaction:'+target}]){
      expect(ownedPaymentMovement({...saved,movements:[{...saved.movements[0],...patch}]},owner,target)).toBeNull();
    }
  });
  it('forwards an older notification to Chat without opening a classification modal or reading finance',async()=>{
    const fetch=vi.spyOn(globalThis,'fetch');
    await expect(screen(target)).rejects.toMatchObject({digest:expect.stringContaining(`/chat?payment=${target}`)});
    expect(mocks.account).not.toHaveBeenCalled();expect(mocks.load).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();fetch.mockRestore();
  });
  it('preserves the locator for Chat sign-in without reading any financial state',async()=>{
    mocks.account.mockResolvedValue({kind:'signed-out'});
    await expect(screen(target)).rejects.toMatchObject({digest:expect.stringContaining(`/chat?payment=${target}`)});
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it.each(['malformed','repeated'] as const)('rejects %s locators without a modal or arbitrary redirect',async condition=>{
    const markup=renderToStaticMarkup(await screen(condition==='malformed'?'https://evil.invalid':[target,target]));
    expect(markup).toContain('That payment isn’t available in this account.');
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain('https://evil.invalid');
  });
});
