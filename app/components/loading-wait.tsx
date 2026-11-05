"use client";

import { useEffect, useState, type ReactNode } from "react";
import { buttonClassName } from "./button-styles";

export const PAGE_LOADING_NOTICE_MS = 15_000;

/** Keep a stalled read actionable; arriving Suspense content still replaces this fallback. */
export function LoadingWait({ label, className, children }: { label: string; className: string; children: ReactNode }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), PAGE_LOADING_NOTICE_MS);
    return () => clearTimeout(timer);
  }, []);
  if (slow) return <section className="alfred-loading-notice" role="alert">
    <h2>This is taking longer than expected.</h2>
    <p>You can reload the page to try loading your records again.</p>
    <button type="button" className={buttonClassName({ variant: "primary" })} onClick={() => window.location.reload()}>Reload page</button>
  </section>;
  return <section className={className} role="status" aria-busy="true" aria-label={label}>
    <p className="sr-only">{label}…</p>
    <div aria-hidden="true">{children}</div>
  </section>;
}
