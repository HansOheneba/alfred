"use client";

import { useState } from "react";

import { DrawnChartView } from "@/app/chat/drawn-chart";
import { buttonClassName } from "@/app/components/button-styles";
import { requestMutationJson } from "@/app/components/mutation-request";
import type { DrawnChart } from "@/lib/finance/charts";
import "./pinned-charts.css";

/** Charts kept from chat. Each recalculates from the books on every visit; removing one leaves the books alone. */
export function PinnedCharts({ pinned }: { pinned: { id: string; chart: DrawnChart }[] }) {
  const [shown, setShown] = useState(pinned);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  if (!shown.length) return null;

  async function remove(id: string) {
    setRemoving(id);
    setError(null);
    try {
      const result = await requestMutationJson<{ ok?: boolean; text?: string }>("/api/pins", "DELETE", { id });
      if (result?.ok === false) throw new Error(result.text ?? "That chart couldn't be removed.");
      setShown((items) => items.filter((item) => item.id !== id));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That chart couldn't be removed.");
    } finally {
      setRemoving(null);
    }
  }

  return (
    <section className="alfred-pinned" aria-label="Charts you kept from chat">
      <div className="alfred-pinned-head">
        <h2>Kept from chat</h2>
        <p>Updated from your books each time you open this page.</p>
      </div>
      {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
      <div className="alfred-pinned-grid">
        {shown.map(({ id, chart }) => (
          <DrawnChartView
            key={id}
            chart={chart}
            footer={<button type="button" className={buttonClassName({ variant: "ghost", size: "sm", className: "alfred-pinned-remove" })} disabled={removing === id} onClick={() => void remove(id)}>{removing === id ? "Removing…" : "Remove"}</button>}
          />
        ))}
      </div>
    </section>
  );
}
