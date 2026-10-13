import { NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/session";

export async function POST(request: Request): Promise<Response> {
  const supabase = await createSupabaseServerClient();
  if (supabase) await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/", request.url), 303);
}
