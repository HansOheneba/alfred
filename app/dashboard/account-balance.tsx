import Link from "next/link";
import { formatMinor } from "@/lib/finance/money";
import type { Ledger } from "@/lib/web/ledger";

export function DashboardAccountBalance({ accounting, currency }: { accounting: NonNullable<Ledger["accounting"]>; currency: string }) {
  const { balances } = accounting;
  const contributing = balances.accounts.filter(({ account }) => account.includeInCash && account.currency === currency);
  return <section className="flex min-w-0 flex-col rounded-2xl border border-line bg-accent-soft p-5" aria-label="Total account balance">
    <div className="flex items-center justify-between gap-4"><h2 className="text-sm font-medium text-accent">Total account balance</h2><Link href="/accounts" className="text-xs text-accent hover:underline">Manage accounts ↗</Link></div>
    <p className="mt-5 text-3xl font-semibold tracking-tight tabular-nums">{balances.totalMinor === null ? "—" : formatMinor(balances.totalMinor, currency)}</p>
    <p className="mt-2 text-xs text-muted">{balances.count} included account{balances.count === 1 ? "" : "s"} · {currency}</p>
    <ul className="mt-5 flex flex-col gap-3 border-t border-line pt-4">{contributing.map(({ account, snapshot }) => <li key={account.id} className="flex items-center justify-between gap-3 text-xs"><div><p>{account.label}</p><p className="mt-1 text-[10px] text-muted">{snapshot ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Accra" }).format(new Date(snapshot.occurredAt)) + " GMT" : "Reported balance needed"}</p></div><strong className="tabular-nums">{snapshot ? formatMinor(snapshot.balanceMinor, currency) : "—"}</strong></li>)}</ul>
    <p className="mt-4 text-[11px] leading-relaxed text-muted">{accounting.availability === "migration-required" ? "Account storage must be set up before saving accounts." : balances.missingCount ? `${balances.missingCount} included account${balances.missingCount === 1 ? " needs" : "s need"} a reported balance before the total is available.` : "Latest reported balances · Not live."} Included cash accounts only. Excludes investments and loans.</p>
  </section>;
}
