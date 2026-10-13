import type { SupabaseSettings } from "@/lib/config";
import { query } from "@/lib/supabase/connection";

export class DbRateLimiter {
  constructor(
    private readonly settings: SupabaseSettings,
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  async allow(key: string, now: number): Promise<boolean> {
    const rows = await query<{ hits: number }>(
      this.settings,
      `insert into public.api_rate_limits (bucket, window_start, hits)
       values ($1, to_timestamp($2::double precision / 1000.0), 1)
       on conflict (bucket) do update
       set hits = case
             when public.api_rate_limits.window_start < to_timestamp($2::double precision / 1000.0) - make_interval(secs => $3::double precision / 1000.0) then 1
             else public.api_rate_limits.hits + 1
           end,
           window_start = case
             when public.api_rate_limits.window_start < to_timestamp($2::double precision / 1000.0) - make_interval(secs => $3::double precision / 1000.0) then to_timestamp($2::double precision / 1000.0)
             else public.api_rate_limits.window_start
           end,
           updated_at = now()
       returning hits`,
      [key, now, this.windowMs],
    );
    return (rows[0]?.hits ?? this.limit + 1) <= this.limit;
  }
}
