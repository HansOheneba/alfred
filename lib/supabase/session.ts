import { createServerClient } from "@supabase/ssr";
import { io } from "next/cache";
import { cookies } from "next/headers";

export async function createSupabaseServerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !anonKey) return null;
  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // The proxy refreshes the session when a Server Component cannot set cookies.
        }
      },
    },
  });
}

export async function getAuthUser() {
  // Supabase compares the session expiry to Date.now(). Cache Components blocks
  // that read outside the dynamic stage, including during the runtime prerender.
  await io();
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  // The project signs sessions with an asymmetric key, so getClaims verifies the
  // JWT locally instead of asking Supabase Auth on every render (an extra round trip).
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub) return null;
  return { id: claims.sub, email: typeof claims.email === "string" ? claims.email : null };
}
