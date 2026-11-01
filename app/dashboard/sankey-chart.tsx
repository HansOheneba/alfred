"use client";

import { useId, useState } from "react";

import { usePrivacyMask } from "@/app/components/app-shell";
import type { SankeyFlowEntry, SankeyFlowModel } from "@/lib/finance/analytics";
import { formatMinor } from "@/lib/finance/money";

type GroupedNode = {
  label: string;
  minor: number;
  kind: "income" | "expense" | "remainder" | "gap";
  members: SankeyFlowEntry[];
  index: number;
  y: number;
  height: number;
};

type BandLink = {
  side: "source" | "destination";
  index: number;
  kind: GroupedNode["kind"];
  minor: number;
  height: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

const PALETTE: Record<GroupedNode["kind"], string[]> = {
  income: ["#398b60", "#72b38c", "#97c7a9", "#588c6b"],
  expense: ["#c15b65", "#d4848b", "#a86974", "#e5a3a6", "#945965", "#b88a93"],
  remainder: ["#9885bc"],
  gap: ["#8d8994"],
};

function groupEntries(entries: SankeyFlowEntry[], max: number, otherLabel: string): { label: string; minor: number; members: SankeyFlowEntry[] }[] {
  const positive = entries.filter((entry) => entry.minor > 0).map((entry) => ({ ...entry, members: [entry] }));
  if (positive.length <= max) return positive;
  const kept = positive.slice(0, max - 1);
  const rest = positive.slice(max - 1);
  return [
    ...kept,
    {
      label: otherLabel,
      minor: rest.reduce((sum, item) => sum + item.minor, 0),
      members: rest.flatMap((item) => item.members),
    },
  ].sort((a, b) => b.minor - a.minor);
}

function bandPath(link: BandLink): string {
  const bend = (link.x1 - link.x0) * 0.46;
  const h = link.height;
  return `M ${link.x0} ${link.y0} C ${link.x0 + bend} ${link.y0} ${link.x1 - bend} ${link.y1} ${link.x1} ${link.y1} L ${link.x1} ${link.y1 + h} C ${link.x1 - bend} ${link.y1 + h} ${link.x0 + bend} ${link.y0 + h} ${link.x0} ${link.y0 + h} Z`;
}

export function CashFlowSankey({ model, currency }: { model: SankeyFlowModel; currency: string }) {
  const idPrefix = `alfred-sankey-${useId().replace(/:/g, "")}`;
  const [masked] = usePrivacyMask();
  const [active, setActive] = useState<{ side: "source" | "destination"; index: number } | null>(null);

  if (masked) {
    return <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">Amounts hidden. Reveal amounts in the top bar to explore cash flow.</p>;
  }

  if (model.massMinor <= 0) {
    return <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">No money movement recorded for this range.</p>;
  }

  const width = 920;
  const height = 370;
  const gap = 34;
  const start = 36;
  const end = height - 20;
  const coords = { left: 200, pool: 430, right: 690, node: 9 };

  const rawSources: Omit<GroupedNode, "index" | "y" | "height">[] = groupEntries(model.sources, 4, "Other income").map((entry) => ({
    ...entry,
    kind: "income",
  }));
  if (model.comparisonGapMinor > 0) {
    rawSources.push({
      label: "Outflow beyond income",
      minor: model.comparisonGapMinor,
      kind: "gap",
      members: [],
    });
  }

  const rawDestinations: Omit<GroupedNode, "index" | "y" | "height">[] = groupEntries(model.expenses, 6, "Other categories").map((entry) => ({
    ...entry,
    kind: "expense",
  }));
  if (model.remainderMinor > 0) {
    rawDestinations.push({
      label: "Net recorded inflow",
      minor: model.remainderMinor,
      kind: "remainder",
      members: [],
    });
  }

  const maxNodes = Math.max(rawSources.length, rawDestinations.length, 1);
  const scale = (end - start - (maxNodes - 1) * gap) / model.massMinor;
  const poolHeight = Math.max(8, model.massMinor * scale);
  const poolY = (start + end - poolHeight) / 2;

  function place(items: Omit<GroupedNode, "index" | "y" | "height">[]): GroupedNode[] {
    const totalHeight = items.reduce((sum, item) => sum + Math.max(4, item.minor * scale), 0) + Math.max(0, items.length - 1) * gap;
    let y = (start + end - totalHeight) / 2;
    return items.map((item, index) => {
      const h = Math.max(4, item.minor * scale);
      const node: GroupedNode = { ...item, index, y, height: h };
      y += h + gap;
      return node;
    });
  }

  const leftNodes = place(rawSources);
  const rightNodes = place(rawDestinations);
  const links: BandLink[] = [];

  let cursorY = poolY;
  for (const node of leftNodes) {
    links.push({
      side: "source",
      index: node.index,
      kind: node.kind,
      minor: node.minor,
      height: node.height,
      x0: coords.left + coords.node,
      y0: node.y,
      x1: coords.pool,
      y1: cursorY,
    });
    cursorY += node.height;
  }

  cursorY = poolY;
  for (const node of rightNodes) {
    links.push({
      side: "destination",
      index: node.index,
      kind: node.kind,
      minor: node.minor,
      height: node.height,
      x0: coords.pool + coords.node,
      y0: cursorY,
      x1: coords.right,
      y1: node.y,
    });
    cursorY += node.height;
  }

  const colorFor = (kind: GroupedNode["kind"], index: number) => PALETTE[kind][index % PALETTE[kind].length]!;
  const inspected = active ? (active.side === "source" ? leftNodes[active.index] : rightNodes[active.index]) : null;
  const caption =
    model.comparisonGapMinor > 0
      ? `Spending exceeds recorded income by ${formatMinor(model.comparisonGapMinor, currency)}. The grey band is the comparison gap, not income.`
      : "Bands compare recorded income and spending totals for this period.";

  return (
    <div className="flex flex-col gap-3">
      <div className="w-full overflow-x-auto">
        <svg viewBox={`0 0 ${width} ${height}`} className="h-auto min-w-[600px] w-full select-none" role="group" aria-label="Income to spending cash flow">
          <defs>
            {links.map((link, idx) => {
              const hue = colorFor(link.kind, link.index);
              return (
                <linearGradient key={idx} id={`${idPrefix}-band-${idx}`}>
                  <stop offset="0%" stopColor={hue} stopOpacity={0.5} />
                  <stop offset="100%" stopColor={hue} stopOpacity={0.22} />
                </linearGradient>
              );
            })}
          </defs>
          <text x={8} y={18} className="fill-muted text-[11px]">
            {model.comparisonGapMinor > 0 ? "Income / gap" : "Income sources"}
          </text>
          <text x={coords.pool + coords.node / 2} y={18} textAnchor="middle" className="fill-muted text-[11px]">
            {model.comparisonGapMinor > 0 ? "Outflow" : "Recorded flow"}
          </text>
          <text x={coords.right + coords.node + 12} y={18} className="fill-muted text-[11px]">
            Spending / net
          </text>

          {links.map((link, idx) => {
            const muted = active !== null && active.side === link.side && active.index !== link.index;
            return (
              <path
                key={idx}
                d={bandPath(link)}
                fill={`url(#${idPrefix}-band-${idx})`}
                opacity={muted ? 0.25 : 1}
                className="transition-opacity"
              />
            );
          })}

          <rect x={coords.pool} y={poolY} width={coords.node} height={poolHeight} rx={2} fill="var(--line-strong)" />

          {leftNodes.map((node) => {
            const hue = colorFor(node.kind, node.index);
            const center = node.y + node.height / 2;
            return (
              <g
                key={`left-${node.index}`}
                tabIndex={0}
                role="button"
                aria-label={`${node.label}: ${formatMinor(node.minor, currency)}`}
                onMouseEnter={() => setActive({ side: "source", index: node.index })}
                onFocus={() => setActive({ side: "source", index: node.index })}
                onClick={() => setActive((curr) => (curr?.side === "source" && curr.index === node.index ? null : { side: "source", index: node.index }))}
                className="cursor-pointer focus:outline-none"
              >
                <rect x={coords.left} y={node.y} width={coords.node} height={node.height} rx={2} fill={hue} />
                <text x={8} y={center - 3} className="fill-ink text-[12.5px] font-medium">
                  {node.label}
                </text>
                <text x={8} y={center + 13} className="fill-muted text-[11.5px] tabular-nums">
                  {formatMinor(node.minor, currency)}
                </text>
              </g>
            );
          })}

          {rightNodes.map((node) => {
            const hue = colorFor(node.kind, node.index);
            const center = node.y + node.height / 2;
            const textX = coords.right + coords.node + 12;
            return (
              <g
                key={`right-${node.index}`}
                tabIndex={0}
                role="button"
                aria-label={`${node.label}: ${formatMinor(node.minor, currency)}`}
                onMouseEnter={() => setActive({ side: "destination", index: node.index })}
                onFocus={() => setActive({ side: "destination", index: node.index })}
                onClick={() => setActive((curr) => (curr?.side === "destination" && curr.index === node.index ? null : { side: "destination", index: node.index }))}
                className="cursor-pointer focus:outline-none"
              >
                <rect x={coords.right} y={node.y} width={coords.node} height={node.height} rx={2} fill={hue} />
                <text x={textX} y={center - 3} className="fill-ink text-[12.5px] font-medium">
                  {node.label}
                </text>
                <text x={textX} y={center + 13} className="fill-muted text-[11.5px] tabular-nums">
                  {formatMinor(node.minor, currency)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>{caption}</span>
        <span role="status" aria-live="polite" className="tabular-nums text-ink">
          {inspected
            ? `${inspected.label} · ${formatMinor(inspected.minor, currency)}${
                inspected.members.length > 1
                  ? ` (${inspected.members.map((m) => `${m.label}: ${formatMinor(m.minor, currency)}`).join(", ")})`
                  : ""
              }`
            : "Hover or tap a branch to inspect."}
        </span>
      </div>
    </div>
  );
}
