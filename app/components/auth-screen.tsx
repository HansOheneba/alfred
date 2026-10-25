import type { ReactNode } from "react";

import { AlfredAvatar } from "@/app/components/alfred-avatar";

export function AuthScreen({ children, mode = "sign-in" }: { children: ReactNode; mode?: "sign-in" | "sign-up" }) {
  const signIn = mode === "sign-in";
  return (
    <main className="auth-screen flex min-h-dvh flex-col overflow-x-hidden lg:flex-row">
      <aside className="auth-brand relative hidden min-h-dvh w-[46%] shrink-0 flex-col justify-center border-r border-line lg:flex xl:w-1/2">
        <div className="auth-noise" aria-hidden="true" />
        <div className="relative flex flex-col px-14 py-16 xl:px-16">
          <AlfredAvatar
            presentation="glow"
            sizeClass="mt-10 size-44 xl:size-52"
            alt=""
            sizes="(min-width: 1280px) 208px, 176px"
            loading="eager"
          />
          <p className="mt-10 max-w-md font-display text-[2.15rem] font-medium leading-[1.15] tracking-tight text-ink xl:text-[2.5rem]">
            {signIn ? "Alfred keeps the books." : "Your money, making more sense."}
          </p>
          <p className="mt-4 max-w-md text-[15px] leading-6 text-muted">
            {signIn
              ? "Someone has to keep you accountable. Tell Alfred where your money goes, and he'll make sure you know too. After all, the mansion won't build itself."
              : "Keep track of what comes in and what goes out, then ask where it went."}
          </p>
        </div>
      </aside>
      <section className="flex min-h-dvh w-full min-w-0 flex-1 flex-col px-5 py-8 sm:px-8 lg:px-16 lg:py-12">
        <div className="mx-auto my-auto w-full max-w-[26rem]">
          <div className="mb-8 flex justify-center lg:hidden">
            <AlfredAvatar sizeClass="size-16" alt="" sizes="64px" loading="eager" />
          </div>
          {children}
        </div>
      </section>
    </main>
  );
}
