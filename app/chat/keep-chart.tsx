"use client";

import Link from "next/link";
import { useState } from "react";

import { buttonClassName } from "@/app/components/button-styles";
import { requestMutationJson } from "@/app/components/mutation-request";
import type { DrawnChart } from "@/lib/finance/charts";
import "@/app/dashboard/pinned-charts.css";

/** Keeps a chart from chat on the Overview, where it recalculates from the books each visit. */
export function KeepChartButton({ chart }: { chart: DrawnChart }) {
  const [state, setState] = useState<"idle" | "saving" | "kept" | { error: string }>("idle");
  if (state === "kept") return <Link href="/dashboard" className="alfred-chart-keep text-xs text-accent underline-offset-2 hover:underline">On your Overview ↗</Link>;

  async function keep() {
    setState("saving");
    try {
      const result = await requestMutationJson<{ ok?: boolean; text?: string }>("/api/pins", "POST", { title: chart.title, query: chart.query });
      if (result?.ok === false) throw new Error(result.text ?? "That chart couldn't be kept.");
      setState("kept");
    } catch (failure) {
      setState({ error: failure instanceof Error ? failure.message : "That chart couldn't be kept." });
    }
  }

  return (
    <span className="alfred-chart-keep inline-flex items-center gap-2">
      {typeof state === "object" ? <span className="text-danger" role="alert">{state.error}</span> : null}
      <button type="button" className={buttonClassName({ variant: "ghost", size: "sm" })} disabled={state === "saving"} onClick={() => void keep()}>
        {state === "saving" ? "Keeping…" : "Keep on Overview"}
      </button>
    </span>
  );
}
