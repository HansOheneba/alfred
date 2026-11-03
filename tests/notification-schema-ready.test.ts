import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import type { SupabaseSettings } from '@/lib/config';
import { notificationPolicyAvailable } from '@/lib/notifications/schema-ready';
import type { Execute } from '@/lib/notifications/store';

describe('notification policy catalog readiness', () => {
  it('distinguishes a missing policy from the exact installed signature without changing any records', async () => {
    const db = new PGlite();
    const execute: Execute = async <T extends Record<string, unknown>>(_s: SupabaseSettings, sql: string, values: unknown[] = []) => (await db.query<T>(sql, values)).rows;
    try {
      expect(await notificationPolicyAvailable({} as SupabaseSettings, execute)).toBe(false);
      await db.exec("create function public.alfred_bank_notice_readiness(uuid,uuid,timestamptz) returns table(state text,ready_at timestamptz) language sql as $$select 'ready'::text,$3$$");
      expect(await notificationPolicyAvailable({} as SupabaseSettings, execute)).toBe(true);
      expect((await db.query('select tablename from pg_tables where schemaname=\'public\'')).rows).toEqual([]);
    } finally { await db.close(); }
  });
  it('fails closed on an inaccessible catalog without exposing the underlying error', async () => {
    const execute: Execute = async () => { throw new Error('synthetic-private-connection-detail'); };
    expect(await notificationPolicyAvailable({} as SupabaseSettings, execute)).toBe(false);
  });
});
