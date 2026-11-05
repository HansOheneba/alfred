import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
const io=vi.hoisted(()=>({owner:vi.fn(),read:vi.fn()}));
vi.mock('next/server',()=>({connection:async()=>undefined}));vi.mock('@/lib/web/api',()=>({requireOwner:io.owner}));
vi.mock('@/lib/web/secondary-read-models',()=>({loadChatContext:io.read,loadSettingsBudgets:io.read,loadSettingsBank:io.read,loadSettingsGoals:io.read}));
vi.mock('@/lib/web/overview',async original=>({...await original<typeof import('@/lib/web/overview')>(),loadOverviewTransactionPage:io.read}));
import { GET as chat } from '@/app/api/chat/context/route';
import { GET as settings } from '@/app/api/settings/ledger/route';
import { GET as overview } from '@/app/api/overview/transactions/route';
import { DurableDisplayUpdating } from '@/lib/finance/accounting/durable-read';
import { loadOwnedChatContext } from '@/app/chat/context-data';
import { readOverviewTransactions,OverviewReadChanged } from '@/app/dashboard/overview-transaction-data';
import { loadOwnedSettingsData } from '@/app/settings/lazy-settings-data';
import { overviewTransactionQueryKey,type OverviewTransactionQuery } from '@/lib/web/overview-transactions';
const query:OverviewTransactionQuery={preset:'this_month',category:null,filters:{search:'',category:'all',type:'all',sort:'date-desc'}};
beforeEach(()=>{vi.resetAllMocks();io.owner.mockResolvedValue({profile:{profileId:'fictional-owner'},settings:{supabase:{}}});io.read.mockRejectedValue(new DurableDisplayUpdating());});afterEach(()=>vi.unstubAllGlobals());
describe('explicit updating responses never masquerade as empty resources',()=>{
 it.each(['chat','budgets','bank','overview'])('returns read-only 202 for %s while a valid generation is unavailable',async section=>{
  const response=section==='chat'?await chat():section==='overview'?await overview(new Request('https://fictional.invalid/api/overview/transactions')):await settings(new Request(`https://fictional.invalid/api/settings/ledger?section=${section}`));
  expect(response.status).toBe(202);expect(response.headers.get('cache-control')).toContain('no-store');
  expect(await response.json()).toEqual({ok:false,updating:true,text:new DurableDisplayUpdating().message});expect(io.read).toHaveBeenCalledOnce();
 });
 it('keeps Chat usable with the explicit updating summary error',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({ok:false,updating:true,text:new DurableDisplayUpdating().message},{status:202})));
  await expect(loadOwnedChatContext('fictional-owner',new AbortController().signal)).rejects.toThrow('updating your financial view');
 });
 it('requires refresh for unavailable Overview facts without retrying automatically',async()=>{
  const request=vi.fn(async()=>Response.json({ok:false,updating:true,text:new DurableDisplayUpdating().message},{status:202}));
  const config={ownerId:'fictional-owner',initialPage:{rows:[],total:0,categories:[],version:'a'.repeat(64),queryKey:overviewTransactionQueryKey(query),nextCursor:null}};
  await expect(readOverviewTransactions(config,query,null,new AbortController().signal,request)).rejects.toBeInstanceOf(OverviewReadChanged);expect(request).toHaveBeenCalledOnce();
 });
 it('keeps Settings updating separate from a successfully loaded empty budget array',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({ok:false,updating:true,text:new DurableDisplayUpdating().message},{status:202})));
  await expect(loadOwnedSettingsData('/api/settings/ledger?section=budgets','budgets','fictional-owner',new AbortController().signal)).rejects.toThrow('updating your financial view');
 });
});
