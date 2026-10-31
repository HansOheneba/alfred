"use client";

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { categoryColor } from "@/app/components/ui";
import type { ChatChart } from "@/lib/accounts/messages";
import { formatMinor } from "@/lib/finance/money";

/** The small interactive chart Alfred attaches to spending and insight replies. */
export function ReplyChart({ chart }: { chart: ChatChart }) {
  const items = chart.items.slice(0, 6).map((item) => ({ ...item, value: item.minor / 100 }));
  const total = chart.items.reduce((sum, item) => sum + item.minor, 0);
  const summary = items.map((item) => `${item.label} ${formatMinor(item.minor, chart.currency)}`).join(", ");

  return (
    <figure className="mt-3 rounded-xl border border-line bg-bg/60 p-3" aria-label={`Spending by category: ${summary}`}>
      <div style={{ height: Math.max(items.length * 30, 90) }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={items} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }}>
            <XAxis type="number" hide />
            <YAxis type="category" dataKey="label" width={92} tickLine={false} axisLine={false} tick={{ fill: "var(--muted)", fontSize: 12 }} />
            <Tooltip
              cursor={{ fill: "var(--gold-soft)" }}
              contentStyle={{ background: "var(--surface)", border: "1px solid var(--line-strong)", borderRadius: 12, color: "var(--ink)", fontSize: 12 }}
              itemStyle={{ color: "var(--ink)" }}
              labelStyle={{ color: "var(--muted)" }}
              formatter={(_value, _name, entry) => {
                const minor = (entry.payload as { minor: number }).minor;
                const share = total > 0 ? Math.round((minor / total) * 100) : 0;
                return [`${formatMinor(minor, chart.currency)} · ${share}%`, "Spent"];
              }}
            />
            <Bar dataKey="value" radius={[0, 6, 6, 0]} maxBarSize={18}>
              {items.map((item, index) => (
                <Cell key={item.label} fill={categoryColor(index)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      {chart.items.length > items.length ? (
        <figcaption className="mt-1 text-xs text-faint">Top {items.length} of {chart.items.length} categories</figcaption>
      ) : null}
    </figure>
  );
}
