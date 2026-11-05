"use client";

import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { categoryColor } from "@/app/components/ui";
import type { DrawnChart } from "@/lib/finance/charts";
import { formatMinor } from "@/lib/finance/money";
import "./drawn-chart.css";

const NEGATIVE = "var(--outgoing)";
const TOOLTIP = {
  contentStyle: { background: "var(--surface)", border: "1px solid var(--line-strong)", borderRadius: 12, color: "var(--ink)", fontSize: 12 },
  itemStyle: { color: "var(--ink)" },
  labelStyle: { color: "var(--muted)" },
};
const AXIS = { fill: "var(--muted)", fontSize: 11 };

/**
 * A chart Alfred drew from the books. Bars and slices ask Alfred for the
 * payments behind them, so every figure can be checked in one tap.
 */
export function DrawnChartView({ chart, onAsk, footer }: { chart: DrawnChart; onAsk?: (text: string) => void; footer?: React.ReactNode }) {
  const money = (minor: number) => formatMinor(minor, chart.currency);
  const comparing = chart.previousTotalMinor !== undefined;
  const data = chart.rows.map((row) => ({ ...row, value: row.minor / 100, before: (row.previous ?? 0) / 100 }));
  const ask = (row: { ask?: string } | undefined) => (row?.ask && onAsk ? () => onAsk(row.ask!) : undefined);
  const clickable = Boolean(onAsk) && chart.rows.some((row) => row.ask);
  const summary = chart.rows.slice(0, 8).map((row) => `${row.label} ${money(row.minor)}`).join(", ");
  const empty = chart.rows.every((row) => row.count === 0);

  const tooltip = (
    <Tooltip
      {...TOOLTIP}
      cursor={{ fill: "var(--accent-soft)" }}
      formatter={(_value, name, entry) => {
        const row = entry.payload as (typeof data)[number];
        if (name === "before") return [money(row.previous ?? 0), chart.previousLabel ?? "Before"];
        return [`${money(row.minor)} · ${row.count} ${row.count === 1 ? "payment" : "payments"}`, chart.subtitle];
      }}
    />
  );

  let body: React.ReactNode;
  if (empty) {
    body = <p className="alfred-chart-empty">Nothing recorded for this yet.</p>;
  } else if (chart.style === "table") {
    body = (
      <div className="alfred-chart-tableWrap">
        <table className="alfred-chart-table">
          <thead><tr><th scope="col">{chart.by === "category" ? "Category" : chart.by === "merchant" ? "Where" : "When"}</th><th scope="col">Amount</th><th scope="col">Count</th>{comparing ? <th scope="col">{chart.previousLabel}</th> : null}</tr></thead>
          <tbody>
            {chart.rows.map((row) => (
              <tr key={row.label}>
                <td>{row.ask && onAsk ? <button type="button" onClick={ask(row)}>{row.label}</button> : row.label}</td>
                <td>{money(row.minor)}</td>
                <td>{row.count}</td>
                {comparing ? <td>{money(row.previous ?? 0)}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  } else if (chart.style === "donut") {
    body = (
      <div className="alfred-chart-donut">
        <div style={{ width: 150, height: 150 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie isAnimationActive={false} data={data} dataKey="value" nameKey="label" innerRadius={44} outerRadius={70} paddingAngle={1} stroke="var(--surface)" onClick={(entry) => ask(entry?.payload as { ask?: string })?.()}>
                {data.map((row, index) => <Cell key={row.label} fill={categoryColor(index)} style={{ cursor: row.ask && onAsk ? "pointer" : "default" }} />)}
              </Pie>
              {tooltip}
            </PieChart>
          </ResponsiveContainer>
        </div>
        <ul className="alfred-chart-legend">
          {chart.rows.map((row, index) => (
            <li key={row.label}>
              <span className="alfred-chart-swatch" style={{ background: categoryColor(index) }} />
              {row.ask && onAsk ? <button type="button" onClick={ask(row)}>{row.label}</button> : <span>{row.label}</span>}
              <span className="alfred-chart-amount">{money(row.minor)}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  } else if (chart.style === "line") {
    body = (
      <div style={{ height: 180 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--line)" vertical={false} />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={44} tickFormatter={(value: number) => compact(value)} />
            {tooltip}
            {comparing ? <Line dataKey="before" stroke="var(--muted)" strokeDasharray="4 4" dot={false} strokeWidth={1.5} isAnimationActive={false} /> : null}
            <Line dataKey="value" stroke="var(--accent)" strokeWidth={2.25} dot={{ r: 2.5 }} activeDot={{ r: 5, onClick: (_event, point) => ask((point as { payload?: { ask?: string } }).payload)?.() }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  } else if (chart.by === "category" || chart.by === "merchant") {
    body = (
      <div style={{ height: Math.max(data.length * (comparing ? 40 : 30), 90) }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }}>
            <XAxis type="number" hide />
            <YAxis type="category" dataKey="label" width={104} tickLine={false} axisLine={false} tick={{ ...AXIS, fontSize: 12 }} />
            {tooltip}
            {comparing ? <Bar isAnimationActive={false} dataKey="before" fill="var(--line-strong)" radius={[0, 6, 6, 0]} maxBarSize={10} /> : null}
            <Bar isAnimationActive={false} dataKey="value" radius={[0, 6, 6, 0]} maxBarSize={18} onClick={(entry) => ask(entry as { ask?: string })?.()}>
              {data.map((row, index) => <Cell key={row.label} fill={row.minor < 0 ? NEGATIVE : categoryColor(index)} style={{ cursor: row.ask && onAsk ? "pointer" : "default" }} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  } else {
    body = (
      <div style={{ height: 180 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--line)" vertical={false} />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={12} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={44} tickFormatter={(value: number) => compact(value)} />
            {tooltip}
            {comparing ? <Bar isAnimationActive={false} dataKey="before" fill="var(--line-strong)" radius={[6, 6, 0, 0]} maxBarSize={14} /> : null}
            <Bar isAnimationActive={false} dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={28} onClick={(entry) => ask(entry as { ask?: string })?.()}>
              {data.map((row) => <Cell key={row.label} fill={row.minor < 0 ? NEGATIVE : "var(--accent)"} style={{ cursor: row.ask && onAsk ? "pointer" : "default" }} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <figure className="alfred-chart" aria-label={`${chart.title}, ${chart.subtitle}: ${summary}`}>
      <header className="alfred-chart-head">
        <div>
          <p className="alfred-chart-title">{chart.title}</p>
          <p className="alfred-chart-sub">{chart.subtitle}</p>
        </div>
        <p className="alfred-chart-total">{money(chart.totalMinor)}</p>
      </header>
      {body}
      <figcaption className="alfred-chart-foot">
        {comparing ? <span><i className="alfred-chart-key" /> {chart.subtitle} <i className="alfred-chart-key is-before" /> {chart.previousLabel}</span> : null}
        {chart.otherCurrencies?.length ? <span>Payments in {chart.otherCurrencies.join(", ")} aren&apos;t included.</span> : null}
        {clickable && !empty ? <span>Tap a {chart.style === "donut" ? "slice" : chart.style === "table" ? "row" : chart.style === "line" ? "point" : "bar"} to see its payments.</span> : null}
        {footer}
      </figcaption>
    </figure>
  );
}

/** 1200 as 1.2k on an axis, where space is short. */
function compact(value: number): string {
  const size = Math.abs(value);
  if (size >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  if (size >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(value));
}
