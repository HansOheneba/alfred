"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type MouseEvent, type ReactNode } from "react";

import { AppShell, useAppearance, type Section } from "@/app/components/app-shell";
import { DashboardClient } from "@/app/dashboard/dashboard-client";
import { previewLedger, previewName } from "@/ui-preview/fixture";
import { usePreviewAccounting } from "@/ui-preview/accounting-store";
import { buildPreviewLedger, previewBalanceAccounts } from "@/ui-preview/accounting-ledger";
import { buildAccountingView } from "@/lib/finance/accounting/view";

import { ConceptDashboardClient } from "./concept-dashboard";
import { PreviewShell } from "./preview-shell";
import { previewStyles as styles } from "./styles";

const previewRoutes: Record<string, string> = { "/chat": "/ui-preview/chat", "/dashboard": "/ui-preview", "/investments": "/ui-preview/investments", "/accounts": "/ui-preview/accounts", "/review": "/ui-preview/accounts?tab=needs-attention", "/notebook": "/ui-preview/chat", "/people": "/ui-preview/chat", "/settings": "/ui-preview/settings", "/": "/ui-preview" };

export function PreviewFrame({ children, section = "dashboard", variant = "concept" }: { children: ReactNode; section?: Section; variant?: "current" | "concept" }) {
  const [appearance, setAppearance] = useAppearance();
  const [notice, setNotice] = useState("");
  const router = useRouter();

  function keepReadOnly(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const button = target.closest("button");
    const localDemoForm = button?.closest('form[data-preview-local-form="true"], [data-preview-local-actions="true"]');
    if (button && !localDemoForm && /^(save|delete|remove|confirm|pause|resume|mark paid|pay|skip|snooze|add bill|accept|dismiss|send)/i.test(button.textContent?.trim() ?? "")) {
      event.preventDefault();
      event.stopPropagation();
      setNotice("Read-only UI preview. These are synthetic records; changes are not saved.");
    }
    const href = target.closest("a")?.getAttribute("href");
    if (href && !href.startsWith("/ui-preview") && !href.startsWith("#")) {
      event.preventDefault();
      event.stopPropagation();
      const source = new URL(href, window.location.origin);
      if (previewRoutes[source.pathname]) {
        const destination = new URL(previewRoutes[source.pathname], window.location.origin);
        source.searchParams.forEach((value, key) => destination.searchParams.set(key, value));
        router.push(destination.pathname + destination.search + source.hash);
      }
      else setNotice("This preview uses synthetic data. External account connections are not enabled.");
    }
  }

  const tools = <div className={styles.previewTools}>
    <span className={styles.demoLabel}>Synthetic data</span>
    <nav aria-label="UI comparison" className={styles.comparison}>
      <Link href="/ui-preview/current" aria-current={variant === "current" ? "page" : undefined}>Current</Link>
      <Link href="/ui-preview" aria-current={variant === "concept" && section === "dashboard" ? "page" : undefined}>Concept</Link>
    </nav>
    <button type="button" className={styles.themeButton} onClick={() => setAppearance(appearance === "light" ? "dark" : "light")} aria-label={`Switch to ${appearance === "light" ? "dark" : "light"} appearance`}>
      {appearance === "light" ? "Dark" : "Light"}
    </button>
  </div>;

  return <div className={variant === "concept" ? styles.study : styles.current} onClickCapture={keepReadOnly} onSubmitCapture={(event) => { if (!(event.target as HTMLFormElement).matches('form[data-preview-local-form="true"]')) { event.preventDefault(); event.stopPropagation(); } }}>
    {variant === "concept" ? <PreviewShell section={section} tools={tools}>{children}</PreviewShell> : <AppShell current={section} name={previewName} headerAction={tools}>{children}</AppShell>}
    {notice ? <div className={styles.notice} role="status"><span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Dismiss preview notice">×</button></div> : null}
  </div>;
}

export function PreviewScreen({ variant }: { variant: "current" | "concept" }) {
  const accounting = usePreviewAccounting();
  const ledger = useMemo(() => buildPreviewLedger(accounting), [accounting]);
  const balanceAccounts = useMemo(() => previewBalanceAccounts(accounting), [accounting]);
  const balanceTotals = useMemo(() => buildAccountingView(accounting, ledger.currency).balances, [accounting, ledger.currency]);
  return <PreviewFrame variant={variant}>
    {variant === "current" ? <DashboardClient ledger={previewLedger} name={previewName} /> : <ConceptDashboardClient ledger={ledger} name={previewName} balanceAccounts={balanceAccounts} balanceTotals={balanceTotals} />}
  </PreviewFrame>;
}
