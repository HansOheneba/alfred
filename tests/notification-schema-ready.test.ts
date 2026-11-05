import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import type { SupabaseSettings } from '@/lib/config';
import { notificationPolicyAvailable } from '@/lib/notifications/schema-ready';
import type { Execute } from '@/lib/notifications/store';
import { readFile } from 'node:fs/promises';

describe('notification policy catalog readiness', () => {
  it('distinguishes a missing policy from the exact installed signature without changing any records', async () => {
    const db = new PGlite();
    const execute: Execute = async <T extends Record<string, unknown>>(_s: SupabaseSettings, sql: string, values: unknown[] = []) => (await db.query<T>(sql, values)).rows;
    try {
      expect(await notificationPolicyAvailable({} as SupabaseSettings, execute)).toBe(false);
      await db.exec("create function public.alfred_bank_notice_readiness(uuid,uuid,timestamptz) returns table(state text,ready_at timestamptz) language sql as $$select 'ready'::text,$3$$");
      expect(await notificationPolicyAvailable({} as SupabaseSettings, execute)).toBe(false);
      await db.exec("create table public.notification_preferences(owner_id uuid, payment_push boolean);insert into notification_preferences values('00000000-0000-4000-8000-000000000001',true)");
      const migration=await readFile(new URL('../supabase/migrations/20261105093000_card_activity_push.sql',import.meta.url),'utf8');
      await db.exec(migration);
      expect(await notificationPolicyAvailable({} as SupabaseSettings, execute)).toBe(true);
      const initial=(await db.query('select owner_id,payment_push,card_activity_push_since from notification_preferences')).rows;
      expect(initial).toEqual([{owner_id:'00000000-0000-4000-8000-000000000001',payment_push:true,card_activity_push_since:expect.any(Date)}]);
      await db.exec(migration);
      expect((await db.query('select owner_id,payment_push,card_activity_push_since from notification_preferences')).rows).toEqual(initial);
    } finally { await db.close(); }
  });
  it('fails closed on an inaccessible catalog without exposing the underlying error', async () => {
    const execute: Execute = async () => { throw new Error('synthetic-private-connection-detail'); };
    expect(await notificationPolicyAvailable({} as SupabaseSettings, execute)).toBe(false);
  });
});
