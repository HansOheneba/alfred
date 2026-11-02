"use client";

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";

import { usePrivacyMask } from "@/app/components/app-shell";
import type { SankeyFlowModel } from "@/lib/finance/analytics";
import { formatMinor } from "@/lib/finance/money";

import "./sankey-chart.css";

type FlowKind = "income" | "expense" | "net" | "gap";
type FlowNode = { key: string; label: string; minor: number; kind: FlowKind };
type Curve = { key: string; path: string; width: number; kind: FlowKind };
type Geometry = { width: number; height: number; curves: Curve[] };

const HUES: Record<FlowKind, string> = { income: "var(--income)", expense: "var(--outgoing)", net: "var(--brand)", gap: "var(--faint)" };

function shareOf(node: FlowNode, model: SankeyFlowModel) {
  const base = node.kind === "expense" ? model.outgoingMinor : node.kind === "income" || node.kind === "net" ? model.incomingMinor : model.massMinor;
  const label = node.kind === "expense" ? "spending" : node.kind === "gap" ? "compared flow" : "recorded income";
  return `${base > 0 ? Math.round((node.minor / base) * 1000) / 10 : 0}% of ${label}`;
}

/** A comparison of recorded flows, never a statement of account balances. */
export function CashFlowSankey({ model, currency }: { model: SankeyFlowModel; currency: string }) {
  const [masked] = usePrivacyMask();
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const diagramRef = useRef<HTMLDivElement>(null);
  const poolRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());
  const prefix = `alfred-flow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const sources = useMemo<FlowNode[]>(() => [
    ...model.sources.filter((entry) => entry.minor > 0).map((entry, index) => ({ ...entry, key: `source-${index}-${entry.label}`, kind: "income" as const })),
    ...(model.comparisonGapMinor > 0 ? [{ key: "comparison-gap", label: "Outflow beyond income", minor: model.comparisonGapMinor, kind: "gap" as const }] : []),
  ], [model]);
  const destinations = useMemo<FlowNode[]>(() => [
    ...model.expenses.filter((entry) => entry.minor > 0).map((entry, index) => ({ ...entry, key: `expense-${index}-${entry.label}`, kind: "expense" as const })),
    ...(model.remainderMinor > 0 ? [{ key: "recorded-net", label: "Net recorded inflow", minor: model.remainderMinor, kind: "net" as const }] : []),
  ], [model]);
  const activeNode = [...sources, ...destinations].find((node) => node.key === (hovered ?? selected));
  const activeKey = activeNode?.key ?? null;

  useEffect(() => {
    const diagram = diagramRef.current;
    const pool = poolRef.current;
    if (masked || !diagram || !pool || model.massMinor <= 0) return;
    let frame = 0;
    const update = () => {
      const area = diagram.getBoundingClientRect();
      const center = pool.getBoundingClientRect();
      const curves: Curve[] = [];
      const addSide = (nodes: FlowNode[], side: "source" | "destination") => {
        const widths = nodes.map((node) => Math.max(1.2, (node.minor / model.massMinor) * 54));
        let cursor = center.top - area.top + center.height / 2 - widths.reduce((sum, width) => sum + width, 0) / 2;
        nodes.forEach((node, index) => {
          const element = nodeRefs.current.get(node.key);
          if (!element) return;
          const bounds = element.getBoundingClientRect();
          const x0 = side === "source" ? bounds.right - area.left : center.right - area.left;
          const x1 = side === "source" ? center.left - area.left : bounds.left - area.left;
          const y0 = side === "source" ? bounds.top - area.top + bounds.height / 2 : cursor + widths[index] / 2;
          const y1 = side === "source" ? cursor + widths[index] / 2 : bounds.top - area.top + bounds.height / 2;
          const bend = Math.max(12, (x1 - x0) * .52);
          curves.push({ key: node.key, kind: node.kind, width: widths[index], path: `M ${x0} ${y0} C ${x0 + bend} ${y0}, ${x1 - bend} ${y1}, ${x1} ${y1}` });
          cursor += widths[index];
        });
      };
      addSide(sources, "source");
      addSide(destinations, "destination");
      setGeometry({ width: area.width, height: area.height, curves });
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    observer.observe(diagram);
    observer.observe(pool);
    nodeRefs.current.forEach((node) => observer.observe(node));
    schedule();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [sources, destinations, model.massMinor, masked]);

  if (masked) return <p className="alfred-flow-empty">Amounts hidden. Reveal amounts in the top bar to explore cash flow.</p>;
  if (model.massMinor <= 0) return <p className="alfred-flow-empty">No money movement recorded for this range.</p>;

  function nodeButton(node: FlowNode) {
    return <li key={node.key} className={node.kind === "gap" ? "alfred-flow-gapItem" : undefined}>
      <button
        ref={(element) => { if (element) nodeRefs.current.set(node.key, element); else nodeRefs.current.delete(node.key); }}
        type="button"
        className={`alfred-flow-node alfred-flow-${node.kind}`}
        style={{ "--flow-hue": HUES[node.kind] } as CSSProperties}
        aria-label={`${node.label}: ${formatMinor(node.minor, currency)}, ${shareOf(node, model)}`}
        aria-pressed={selected === node.key}
        onMouseEnter={() => setHovered(node.key)}
        onMouseLeave={() => setHovered(null)}
        onFocus={() => setHovered(node.key)}
        onBlur={() => setHovered(null)}
        onClick={() => setSelected((current) => current === node.key ? null : node.key)}
        onKeyDown={(event) => { if (event.key === "Escape") { setSelected(null); setHovered(null); } }}
      ><span className="alfred-flow-nodeLabel">{node.label}{node.kind === "gap" ? <small>Comparison gap, not income</small> : null}</span><span className="alfred-flow-nodeAmount tabular-nums">{formatMinor(node.minor, currency)}</span></button>
    </li>;
  }

  const gap = model.comparisonGapMinor > 0;
  return <div className="alfred-flow" role="group" aria-label="Income to spending cash flow" aria-describedby={`${prefix}-caption`}>
    <div className="alfred-flow-headings" aria-hidden="true"><p>{gap ? "Income + comparison gap" : "Income sources"}</p><p>Period totals</p><p>Spending / net</p></div>
    <div className="alfred-flow-diagram" ref={diagramRef}>
      {geometry ? <svg className="alfred-flow-curves" viewBox={`0 0 ${geometry.width} ${geometry.height}`} aria-hidden="true"><defs>{geometry.curves.map((curve) => <linearGradient key={curve.key} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={geometry.width} y2="0" id={`${prefix}-${curve.key.replace(/[^a-zA-Z0-9_-]/g, "")}`}><stop offset="0%" stopColor={HUES[curve.kind]} stopOpacity=".34"/><stop offset="100%" stopColor={HUES[curve.kind]} stopOpacity=".57"/></linearGradient>)}</defs>{geometry.curves.map((curve) => <path key={curve.key} d={curve.path} stroke={`url(#${prefix}-${curve.key.replace(/[^a-zA-Z0-9_-]/g, "")})`} strokeWidth={curve.width} fill="none" opacity={activeKey && activeKey !== curve.key ? .2 : 1}/>)}</svg> : null}
      <div className="alfred-flow-sources"><h3 className="alfred-flow-mobileTitle">{gap ? "Income + comparison gap" : "Income sources"}</h3><ul aria-label="Income flow sources">{sources.map(nodeButton)}</ul></div>
      <div className="alfred-flow-pool" ref={poolRef}>
        <span className="alfred-flow-poolEyebrow">{gap ? "Compared flow" : "Recorded income"}</span>
        <p className="alfred-flow-poolValue tabular-nums">{formatMinor(gap ? model.massMinor : model.incomingMinor, currency)}</p>
        <p className="alfred-flow-poolNote">For this period</p>
        <dl><div><dt>Spent</dt><dd className="tabular-nums">{formatMinor(model.outgoingMinor, currency)}</dd></div><div><dt>{gap ? "Beyond income" : "Net recorded inflow"}</dt><dd className={`tabular-nums ${gap ? "alfred-flow-gapValue" : "alfred-flow-netValue"}`}>{formatMinor(gap ? model.comparisonGapMinor : model.remainderMinor, currency)}</dd></div></dl>
      </div>
      <div className="alfred-flow-destinations"><h3 className="alfred-flow-mobileTitle">Spending / net</h3><ul aria-label="Spending and net flow destinations">{destinations.map(nodeButton)}</ul></div>
    </div>
    <div className="alfred-flow-footer">
      <p id={`${prefix}-caption`}>{gap ? <>Spending exceeds recorded income by <span className="amount">{formatMinor(model.comparisonGapMinor, currency)}</span>. The grey branch shows this comparison gap, not additional income.</> : "Recorded income separates into spending and net recorded inflow. This compares period totals, not account balances or traced transfers."}</p>
      <p className="alfred-flow-inspection" role="status" aria-live="polite">{activeNode ? <><strong>{activeNode.label}</strong><span className="tabular-nums">{formatMinor(activeNode.minor, currency)}</span><span>{shareOf(activeNode, model)}</span></> : "Select or focus a branch to inspect its share."}</p>
    </div>
  </div>;
}
