"use client";

import { useState } from "react";
import { DrawnChartView } from "@/app/chat/drawn-chart";
import { chartSummary, type DrawnChart } from "@/lib/finance/charts";

/** Each sample as it would sit in chat: the question, Alfred's line, and the chart. Taps are shown, never sent. */
export function ChartsPreview({ samples }: { samples: { ask: string; chart: DrawnChart }[] }) {
  const [tapped, setTapped] = useState<string | null>(null);
  return (
    <main className="mx-auto grid max-w-2xl gap-10 px-4 py-10">
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold">Charts in chat</h1>
        <p className="text-sm text-muted">Fictional books. Tapping a bar shows what Alfred would be asked.</p>
        {tapped ? <p className="text-sm" role="status">Would ask: “{tapped}”</p> : null}
      </header>
      {samples.map(({ ask, chart }) => (
        <section key={ask} className="grid gap-2">
          <p className="justify-self-end rounded-xl bg-surface px-3 py-1.5 text-sm">{ask}</p>
          <p className="text-sm">{chartSummary(chart)}</p>
          <DrawnChartView chart={chart} onAsk={setTapped} />
        </section>
      ))}
    </main>
  );
}
