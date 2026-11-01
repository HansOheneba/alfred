import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AuthForm } from "@/app/auth-form";
import { AlfredMark } from "@/app/components/app-shell";
import { MissingAuthConfig, publicAuthConfigured } from "@/app/signed-in";
import { getAuthUser } from "@/lib/supabase/session";
import { HOME_COOKIE, HOME_PATHS, readHome } from "@/lib/web/home";

/** Signed out: the sign-in form. Signed in: the screen the person chose as home (Chat by default). */
export default function Home() {
  if (!publicAuthConfigured()) return <MissingAuthConfig />;

  return (
    <Suspense fallback={<HomeLoading />}>
      <HomeGate />
    </Suspense>
  );
}

function HomeLoading() {
  return (
    <div className="grid h-dvh place-items-center bg-bg">
      <AlfredMark size="size-10" />
    </div>
  );
}

async function HomeGate() {
  const user = await getAuthUser();
  if (!user) return <AuthForm mode="sign-in" />;
  const home = readHome((await cookies()).get(HOME_COOKIE)?.value);
  redirect(HOME_PATHS[home]);
}
