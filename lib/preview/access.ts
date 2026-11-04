/** Fictional pages only. This never enables a real account or delivery path. */
export const AUTOMATION_PREVIEW_PATHS = [
  "/preview/automations",
  "/preview/automations/mac-setup",
  "/preview/automations/transfer",
  "/preview/sms-automation",
] as const;

type PreviewEnvironment = Record<string, string | undefined>;

export function automationPreviewAllowed(environment: PreviewEnvironment): boolean {
  // Vercel reserves this value; a production deployment stays closed even if
  // the local-development flag was accidentally copied into its environment.
  if (environment.VERCEL_ENV === "production") return false;
  if (environment.VERCEL_ENV === "preview") return true;
  if (environment.VERCEL_ENV !== undefined && environment.VERCEL_ENV !== "development") return false;
  return (environment.NODE_ENV === "development" || environment.NODE_ENV === "test")
    && environment.ALFRED_LOCAL_PREVIEW === "1";
}

export function automationPreviewBypassesAuth(pathname: string, method: string, environment: PreviewEnvironment): boolean {
  return (method === "GET" || method === "HEAD")
    && automationPreviewAllowed(environment)
    && isAutomationPreviewPath(pathname);
}

export function isAutomationPreviewPath(pathname: string): boolean {
  return AUTOMATION_PREVIEW_PATHS.some(path => path === pathname);
}
