import { formatMinor } from "@/lib/finance/money";

export function WeeklyComparison({ currentMinor, previousMinor, changePercent, currency }: { currentMinor: number; previousMinor: number; changePercent: number | null; currency: string }) {
  const maximum = Math.max(currentMinor, previousMinor, 1);
  return <div className="alfred-weekly-comparison col-span-full border-t border-line pt-4" role="region" aria-label="Weekly spending comparison">
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 className="text-xs font-medium text-muted">This week so far</h2>
      <p className="text-xl font-semibold tracking-tight tabular-nums">{formatMinor(currentMinor, currency)}</p>
    </div>
    <div className="mt-3 grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2 text-xs text-muted">
      <div className="h-1 overflow-hidden rounded-full bg-surface-2" aria-hidden="true"><div className="h-full rounded-full bg-accent" style={{ width: `${currentMinor / maximum * 100}%` }}/></div><span>This week</span>
      <div className="h-1 overflow-hidden rounded-full bg-surface-2" aria-hidden="true"><div className="h-full rounded-full bg-muted opacity-40" style={{ width: `${previousMinor / maximum * 100}%` }}/></div><span>Last week</span>
    </div>
    <p className="mt-2 text-xs text-muted">{changePercent === null ? "Same days last week" : <span className={changePercent <= 0 ? "text-success" : "text-danger"}>{changePercent > 0 ? "+" : ""}{changePercent}% vs same days last week</span>} · <span className="tabular-nums">{formatMinor(previousMinor, currency)}</span></p>
  </div>;
}
