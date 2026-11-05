import type { ReactNode } from "react";
import { Skeleton } from "./status";
import "./page-skeletons.css";

function LoadingFrame({ label, className = "", children }: { label: string; className?: string; children: ReactNode }) {
  return <section className={`alfred-loading ${className}`} role="status" aria-busy="true" aria-label={label}>
    <p className="sr-only">{label}…</p>
    <div aria-hidden="true">{children}</div>
  </section>;
}

function LoadingHeading({ title, action = false }: { title: string; action?: boolean }) {
  return <div className="alfred-loading-heading"><div><h1>{title}</h1><Skeleton className="alfred-loading-copy" /></div>{action ? <Skeleton className="alfred-loading-action" /> : null}</div>;
}

function MetricPlaceholder({ balance = false }: { balance?: boolean }) {
  return <div className={`alfred-loading-card alfred-loading-metric${balance ? " alfred-loading-balance" : ""}`}>
    <Skeleton className="alfred-loading-label" /><Skeleton className="alfred-loading-value" /><Skeleton className="alfred-loading-copy" />
    {balance ? <Skeleton className="alfred-loading-accountDisclosure" /> : null}
  </div>;
}

function RowsPlaceholder({ count = 4 }: { count?: number }) {
  return <div className="alfred-loading-rows">{Array.from({ length: count }, (_, index) => <div key={index} className="alfred-loading-row">
    <Skeleton className="alfred-loading-rowIcon" /><div><Skeleton className="alfred-loading-rowTitle" /><Skeleton className="alfred-loading-rowCopy" /></div><Skeleton className="alfred-loading-rowAmount" />
  </div>)}</div>;
}

export function DashboardSkeleton() {
  return <LoadingFrame label="Loading your financial overview" className="alfred-loading-overview">
    <LoadingHeading title="Overview" action />
    <div className="alfred-loading-overviewSummary"><MetricPlaceholder balance /><MetricPlaceholder /><MetricPlaceholder /></div>
    <div className="alfred-loading-card alfred-loading-weekly"><Skeleton className="alfred-loading-label" /><Skeleton className="alfred-loading-copy" /><Skeleton className="alfred-loading-weeklyBar" /></div>
    <div className="alfred-loading-card alfred-loading-overviewTransactions"><div className="alfred-loading-activityHeading"><Skeleton className="alfred-loading-label" /><Skeleton className="alfred-loading-filter" /></div><RowsPlaceholder /></div>
    <div className="alfred-loading-overviewPlans">{[0, 1, 2, 3].map(index => <div className="alfred-loading-card" key={index}><Skeleton className="alfred-loading-label" /><Skeleton className="alfred-loading-copy" /><Skeleton className="alfred-loading-field" /></div>)}</div>
    <div className="alfred-loading-card alfred-loading-overviewInsights"><Skeleton className="alfred-loading-label" /><Skeleton className="alfred-loading-copy" /></div>
  </LoadingFrame>;
}

export function AccountsSkeleton() {
  return <LoadingFrame label="Loading your account records" className="alfred-loading-accounts">
    <LoadingHeading title="Accounts" />
    <MetricPlaceholder balance />
    <div className="alfred-loading-activityHeading"><Skeleton className="alfred-loading-sectionTitle" /><Skeleton className="alfred-loading-filter" /></div>
    <div className="alfred-loading-scopes">{[0, 1, 2, 3].map(index => <Skeleton key={index} />)}</div>
    <div className="alfred-loading-card alfred-loading-activity"><RowsPlaceholder count={5} /></div>
  </LoadingFrame>;
}

function SettingsNavigationPlaceholder() {
  return <div className="alfred-loading-settingsNavigation">{Array.from({ length: 11 }, (_, index) => <div key={index} className="alfred-loading-settingsItem"><Skeleton className="alfred-loading-rowIcon" /><div><Skeleton className="alfred-loading-rowTitle" /><Skeleton className="alfred-loading-rowCopy" /></div></div>)}</div>;
}

export function SettingsSkeleton() {
  return <LoadingFrame label="Loading your settings" className="alfred-loading-settings">
    <LoadingHeading title="Settings" />
    <div className="alfred-loading-settingsLayout"><SettingsNavigationPlaceholder /><div className="alfred-loading-settingsProfile"><Skeleton className="alfred-loading-copy" /><SettingsFieldsPlaceholder /></div></div>
  </LoadingFrame>;
}

function SettingsFieldsPlaceholder() {
  return <div className="alfred-loading-card"><Skeleton className="alfred-loading-label" /><div className="alfred-loading-form">{[0, 1, 2, 3].map(index => <div key={index}><Skeleton className="alfred-loading-label" /><Skeleton className="alfred-loading-field" /><Skeleton className="alfred-loading-rowCopy" /></div>)}</div><Skeleton className="alfred-loading-field alfred-loading-textarea" /></div>;
}

export function SettingsSectionSkeleton({ title }: { title: string }) {
  return <LoadingFrame label={`Loading ${title.toLowerCase()}`} className="alfred-loading-settingsSection">
    <div className="alfred-loading-card"><h2>{title}</h2>{title === "Budgets" || title === "Savings goals" ? <div className="alfred-loading-plans">{[0, 1].map(index => <div className="alfred-loading-plan" key={index}><Skeleton className="alfred-loading-label" /><Skeleton className="alfred-loading-value" /><Skeleton className="alfred-loading-weeklyBar" /><Skeleton className="alfred-loading-copy" /></div>)}</div> : <><Skeleton className="alfred-loading-copy" /><Skeleton className="alfred-loading-field" /><Skeleton className="alfred-loading-field" /></>}</div>
  </LoadingFrame>;
}

export function InvestmentsSkeleton() {
  return <LoadingFrame label="Loading your investments" className="alfred-loading-investments">
    <LoadingHeading title="Investments" action />
    <div className="alfred-loading-card alfred-loading-investmentSummary"><div><Skeleton className="alfred-loading-label" /><Skeleton className="alfred-loading-value" /><Skeleton className="alfred-loading-copy" /></div><div className="alfred-loading-investmentFacts"><Skeleton /><Skeleton /></div></div>
    <div className="alfred-loading-investmentGrid"><div className="alfred-loading-card"><Skeleton className="alfred-loading-label" /><Skeleton className="alfred-loading-chart" /></div><div className="alfred-loading-card"><Skeleton className="alfred-loading-label" /><RowsPlaceholder count={3} /></div></div>
    <div className="alfred-loading-investmentGrid">{[0, 1].map(index => <div className="alfred-loading-card" key={index}><Skeleton className="alfred-loading-label" /><Skeleton className="alfred-loading-value" /><Skeleton className="alfred-loading-copy" /></div>)}</div>
  </LoadingFrame>;
}
