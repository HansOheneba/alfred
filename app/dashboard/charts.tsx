"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { categoryColor } from "@/app/components/ui";
import { compactMoney } from "@/app/dashboard/helpers";
import { formatMinor } from "@/lib/finance/money";

type TooltipEntry = { name?: string | number; value?: number | string; color?: string; dataKey?: string | number };
type TooltipArgs = { active?: boolean; payload?: readonly TooltipEntry[]; label?: string | number };

function MoneyTooltip({ active, payload, label, currency }: TooltipArgs & { currency: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-line-strong bg-surface px-3 py-2 text-xs shadow-xl">
      {label != null && label !== "" ? <p className="mb-1 text-muted">{label}</p> : null}
      {payload.map((entry) => (
        <p key={String(entry.dataKey ?? entry.name)} className="flex items-center gap-2 tabular-nums text-ink">
          <span className="size-2 rounded-full" style={{ background: entry.color }} aria-hidden="true" />
          <span className="text-muted">{entry.name}</span>
          <span className="ml-auto font-medium">{formatMinor(Number(entry.value ?? 0), currency)}</span>
        </p>
      ))}
    </div>
  );
}

const axis = { stroke: "var(--faint)", fontSize: 11, tickLine: false, axisLine: false } as const;

export function MonthlyChart({ data, currency }: { data: { label: string; spent: number; income: number }[]; currency: string }) {
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }} barGap={4}>
          <CartesianGrid vertical={false} stroke="var(--line)" />
          <XAxis dataKey="label" {...axis} />
          <YAxis {...axis} className="amount" width={56} tickFormatter={(value: number) => compactMoney(value, currency)} />
          <Tooltip cursor={{ fill: "var(--accent-soft)" }} content={(props) => <MoneyTooltip {...(props as TooltipArgs)} currency={currency} />} />
          <Bar dataKey="income" name="Income" fill="var(--income)" radius={[4, 4, 0, 0]} maxBarSize={28} />
          <Bar dataKey="spent" name="Spent" fill="var(--outgoing)" radius={[4, 4, 0, 0]} maxBarSize={28} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function DailyChart({
  data,
  currency,
  mode,
}: {
  data: { label: string; spent: number; cumulative: number }[];
  currency: string;
  mode: "daily" | "cumulative";
}) {
  const key = mode === "daily" ? "spent" : "cumulative";
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="alfred-accent-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--outgoing)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--outgoing)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--line)" />
          <XAxis dataKey="label" {...axis} minTickGap={24} />
          <YAxis {...axis} className="amount" width={56} tickFormatter={(value: number) => compactMoney(value, currency)} />
          <Tooltip content={(props) => <MoneyTooltip {...(props as TooltipArgs)} currency={currency} />} />
          <Area
            type={mode === "daily" ? "monotone" : "linear"}
            dataKey={key}
            name={mode === "daily" ? "Spent" : "Running total"}
            stroke="var(--outgoing)"
            strokeWidth={2}
            fill="url(#alfred-accent-fill)"
            activeDot={{ r: 4 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function CategoryDonut({
  data,
  currency,
  selected,
  onSelect,
}: {
  data: { category: string; minor: number }[];
  currency: string;
  selected: string | null;
  onSelect: (category: string) => void;
}) {
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Tooltip content={(props) => <MoneyTooltip {...(props as TooltipArgs)} currency={currency} />} />
          <Pie
            data={data}
            dataKey="minor"
            nameKey="category"
            innerRadius="58%"
            outerRadius="90%"
            paddingAngle={2}
            stroke="var(--surface)"
            strokeWidth={2}
            onClick={(entry: { category?: string; payload?: { category?: string } }) => {
              const category = entry.category ?? entry.payload?.category;
              if (category) onSelect(category);
            }}
            className="cursor-pointer"
          >
            {data.map((item, index) => (
              <Cell
                key={item.category}
                fill={categoryColor(index)}
                opacity={selected && selected !== item.category ? 0.3 : 1}
              />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

export function SimpleBars({
  data,
  currency,
  height = "h-48",
  name = "Spent",
  color = "var(--outgoing)",
}: {
  data: { label: string; spent: number }[];
  currency: string;
  height?: string;
  name?: string;
  color?: string;
}) {
  return (
    <div className={`${height} w-full`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--line)" />
          <XAxis dataKey="label" {...axis} />
          <YAxis {...axis} className="amount" width={56} tickFormatter={(value: number) => compactMoney(value, currency)} />
          <Tooltip cursor={{ fill: "var(--accent-soft)" }} content={(props) => <MoneyTooltip {...(props as TooltipArgs)} currency={currency} />} />
          <Bar dataKey="spent" name={name} fill={color} radius={[4, 4, 0, 0]} maxBarSize={36} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
