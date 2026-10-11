import { Suspense } from "react";

import { getStudioSettings, isStudioEnabled } from "@/lib/env";
import { StudioConsole } from "@/app/studio-console";

export default function Home() {
  return (
    <Suspense fallback={<ConsoleShell />}>
      <StudioHome />
    </Suspense>
  );
}

function ConsoleShell() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Alfred</h1>
    </main>
  );
}

async function StudioHome() {
  if (!isStudioEnabled()) {
    return (
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-6 py-16">
        <h1 className="text-2xl font-semibold tracking-tight">Alfred</h1>
        <p className="mt-3 text-sm leading-6 text-neutral-600 dark:text-neutral-400">
          The test console is off. Financial records stay in the ledger.
        </p>
      </main>
    );
  }

  let userIds: number[] = [];
  let configError: string | undefined;
  try {
    userIds = getStudioSettings().authorizedUserIds;
  } catch (error) {
    configError = error instanceof Error ? error.message : "The console could not load its configuration.";
  }
  return <StudioConsole userIds={userIds} configError={configError} />;
}
