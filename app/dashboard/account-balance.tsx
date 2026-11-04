import Link from "next/link";
import { buttonClassName } from "@/app/components/button-styles";
import { formatMinor } from "@/lib/finance/money";
import type { Ledger } from "@/lib/web/ledger";

/** Uses the existing account snapshot total, never provider balances or income. */
export function DashboardAccountBalance({ accounting, currency, timeZone = "Africa/Accra" }: { accounting?: Ledger["accounting"]; currency: string; timeZone?: string }) {
  const balances = accounting?.balances;
  const contributing = balances?.accounts.filter(({ account }) => account.includeInCash && account.currency === currency) ?? [];
  const count = balances?.count ?? 0;
  const total = balances?.totalMinor ?? null;
  const stamp = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone, timeZoneName: "short" });
  const note = !accounting ? "Account balances are unavailable." : accounting.availability === "migration-required" ? "Account storage must be set up before saving accounts." : !count ? "Add an account and record its balance to see your total." : balances?.missingCount ? `${balances.missingCount} included account${balances.missingCount === 1 ? " needs" : "s need"} a reported balance before the total is available.` : "Latest reported balances · Not live";

  return <section className="alfred-ui-totalBalance alfred-ui-totalBalance--compact" aria-label="Total account balance">
    <div className="alfred-ui-balanceHeading"><h2>Total account balance</h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7h16a2 2 0 0 1 2 2v10H5a2 2 0 0 1-2-2V7Zm0 0V5a2 2 0 0 1 2-2h12v4m0 5h4m-4 0v3h4"/></svg></div>
    <p className="alfred-ui-totalValue tabular-nums">{total === null ? "—" : formatMinor(total, currency)}</p>
    {total === null ? <p className="alfred-ui-balanceUnavailable">{note}</p> : null}
    <details className="alfred-ui-balanceAccounts">
    <summary className="alfred-ui-balanceDisclosure">
      <span className="alfred-ui-accountCount"><span>{count} included account{count === 1 ? "" : "s"}</span></span>
      <span className="alfred-ui-balanceDisclosureAction"><span className="alfred-ui-balanceShow">Show accounts</span><span className="alfred-ui-balanceHide">Hide accounts</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></span>
    </summary>
    <ul className="alfred-ui-accountBreakdown" aria-label="Accounts contributing to total">
      {contributing.map(({ account, snapshot }) => <li key={account.id}><div><span>{account.label}</span>{snapshot ? <time dateTime={snapshot.occurredAt}>{stamp.format(new Date(snapshot.occurredAt))}</time> : <p className="text-xs text-muted">Reported balance needed</p>}</div><strong className="tabular-nums">{snapshot ? formatMinor(snapshot.balanceMinor, currency) : "—"}</strong></li>)}
      {contributing.length === 0 ? <li><p className="text-xs text-muted">{accounting?.availability === "ready" ? "No included accounts yet." : "No account balances available."}</p></li> : null}
    </ul>
    <div className="alfred-ui-balanceFootnote"><p>{note}</p><p>Included cash accounts. Excludes investments and loans.</p><Link href="/accounts" className={buttonClassName({ variant: "ghost", size: "sm", className: "mt-2" })}>Manage accounts ↗</Link></div>
    </details>
  </section>;
}
