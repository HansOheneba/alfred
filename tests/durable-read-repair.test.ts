import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
const io=vi.hoisted(()=>({query:vi.fn(),fresh:vi.fn()}));
vi.mock('@/lib/supabase/connection',()=>({query:io.query}));
vi.mock('@/lib/finance/accounting/display-worker',()=>({ensureFreshDisplay:io.fresh}));
import { tryReadDurableBundle,DurableDisplayUpdating } from '@/lib/finance/accounting/durable-read';
import { DatabaseError } from '@/lib/errors';
import type { SupabaseSettings } from '@/lib/config';
const OWNER='10000000-0000-4000-8000-000000000001',settings={} as SupabaseSettings,SQL='select fictional_bound_resource';
const bundle={token:'7',manifest:{kind:'accounting-display',projectorVersion:1,ownerId:OWNER,revision:2,sourceVersion:'fictional-source'},data:{spentMinor:1234}};
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('ALFRED_DURABLE_DISPLAY','true');io.fresh.mockResolvedValue(false);});afterEach(()=>vi.unstubAllEnvs());
describe('durable read repair and fallback boundary',()=>{
 it('uses one SQL query on a fresh hit without invoking a worker',async()=>{
  io.query.mockResolvedValue([{bundle}]);await expect(tryReadDurableBundle(settings,OWNER,SQL,['fictional-filter'])).resolves.toEqual(bundle);
  expect(io.query).toHaveBeenCalledExactlyOnceWith(settings,SQL,[OWNER,'accounting-display-v1','fictional-filter']);expect(io.fresh).not.toHaveBeenCalled();
 });
 it.each([true,false])('awaits nonblocking owner repair, then rechecks exactly once (worker result %s)',async result=>{
  io.query.mockResolvedValueOnce([{bundle:null}]).mockResolvedValueOnce([{bundle}]);io.fresh.mockResolvedValue(result);
  await expect(tryReadDurableBundle(settings,OWNER,SQL,['fictional-filter'])).resolves.toEqual(bundle);
  expect(io.fresh).toHaveBeenCalledExactlyOnceWith(settings,OWNER);expect(io.query).toHaveBeenCalledTimes(2);
  expect(io.query.mock.calls[0]).toEqual(io.query.mock.calls[1]);expect(io.query.mock.calls.some(([,sql])=>sql.includes('enqueue'))).toBe(false);
 });
 it('reports updating after one unsuccessful recheck without returning stale or empty data',async()=>{
  io.query.mockResolvedValue([{bundle:null}]);await expect(tryReadDurableBundle(settings,OWNER,SQL)).rejects.toBeInstanceOf(DurableDisplayUpdating);
  expect(io.query).toHaveBeenCalledTimes(2);expect(io.fresh).toHaveBeenCalledOnce();
 });
 it('does not query or repair when disabled',async()=>{
  vi.stubEnv('ALFRED_DURABLE_DISPLAY','false');await expect(tryReadDurableBundle(settings,OWNER,SQL)).resolves.toBeNull();expect(io.query).not.toHaveBeenCalled();expect(io.fresh).not.toHaveBeenCalled();
 });
 it('falls back only when the additive schema is absent',async()=>{
  io.query.mockRejectedValueOnce(new DatabaseError('Missing schema','3F000')).mockResolvedValueOnce([{ready:false}]);
  await expect(tryReadDurableBundle(settings,OWNER,SQL)).resolves.toBeNull();expect(io.fresh).not.toHaveBeenCalled();
  io.query.mockRejectedValueOnce(new DatabaseError('Internal function drift','42883')).mockResolvedValueOnce([{ready:true}]);
  await expect(tryReadDurableBundle(settings,OWNER,SQL)).rejects.toThrow('Internal function drift');
 });
 it.each(['42501','08006'])('propagates permission/connectivity error %s without fallback',async code=>{
  io.query.mockRejectedValue(new DatabaseError('Fictional unavailable',code));await expect(tryReadDurableBundle(settings,OWNER,SQL)).rejects.toThrow('Fictional unavailable');expect(io.query).toHaveBeenCalledOnce();expect(io.fresh).not.toHaveBeenCalled();
 });
 it.each([{...bundle,manifest:{...bundle.manifest,ownerId:'foreign-owner'}},{...bundle,data:{spentMinor:Number.MAX_SAFE_INTEGER+1}}])('rejects unverified owner or unsafe totals',async bad=>{
  io.query.mockResolvedValue([{bundle:bad}]);await expect(tryReadDurableBundle(settings,OWNER,SQL)).rejects.toThrow(/verified|precision/);expect(io.fresh).not.toHaveBeenCalled();
 });
});
