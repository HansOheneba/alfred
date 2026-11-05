import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { automationPreviewAllowed } from "@/lib/preview/access";
import { drawChart, type ChartQuery, type DrawnChart } from "@/lib/finance/charts";
import type { TransactionRecord } from "@/lib/finance/types";
import { ChartsPreview } from "./preview";

export const metadata: Metadata = { title: "Charts preview · Alfred", robots: { index: false, follow: false } };

export default function ChartsPreviewPage() {
  return <Suspense fallback={<p className="p-8 text-sm text-muted">Drawing the sample charts…</p>}><LocalPreview /></Suspense>;
}

const today = "2026-11-20";
let sequence = 0;
const row = (date: string, type: "income" | "expense", amount: string, category: string, description: string): TransactionRecord => ({
  transactionId: `sample-${++sequence}`, createdAt: `${date}T12:00:00.000Z`, transactionDate: date, userId: "sample", type, amount, currency: "GHS", category, description,
  paymentMethod: "", notes: "", status: "active", updatedAt: `${date}T12:00:00.000Z`, sourceUpdateId: `sample:${sequence}`, rowNumber: sequence,
});

/** Fictional books only: no real person, account or payment. */
function sampleBooks(): TransactionRecord[] {
  const rows: TransactionRecord[] = [];
  for (const month of ["06", "07", "08", "09", "10", "11"]) {
    rows.push(row(`2026-${month}-01`, "income", "4200.00", "Salary", "Salary"));
    rows.push(row(`2026-${month}-03`, "expense", "1500.00", "Rent & home", "Rent share"));
    rows.push(row(`2026-${month}-05`, "expense", "180.00", "Utilities", "ECG prepaid"));
    rows.push(row(`2026-${month}-07`, "expense", "120.00", "Subscriptions", "Fibre"));
  }
  const food = [["02", "45.00", "Waakye"], ["04", "30.00", "Kelewele"], ["06", "220.00", "Melcom groceries"], ["09", "60.00", "Jollof"], ["12", "180.00", "Shoprite"], ["15", "35.00", "Waakye"], ["17", "95.00", "Banku and tilapia"], ["19", "40.00", "Waakye"]];
  for (const [day, amount, description] of food) rows.push(row(`2026-11-${day}`, "expense", amount, "Food", description));
  for (const [day, amount] of [["03", "25.00"], ["08", "42.00"], ["11", "18.00"], ["16", "60.00"]]) rows.push(row(`2026-11-${day}`, "expense", amount, "Transport", "Uber"));
  for (const [day, amount, description] of [["04", "70.00", "Waakye"], ["10", "260.00", "Shoprite"], ["18", "140.00", "Melcom groceries"], ["22", "90.00", "Jollof"]]) rows.push(row(`2026-10-${day}`, "expense", amount, "Food", description));
  rows.push(row("2026-10-15", "expense", "600.00", "Social", "Wedding contribution"));
  return rows;
}

async function LocalPreview() {
  await connection();
  if (!automationPreviewAllowed(process.env)) notFound();
  const books = sampleBooks();
  const queries: { ask: string; query: ChartQuery }[] = [
    { ask: "Where did my money go this month vs last month?", query: { measure: "spending", by: "category", compare: true, period: "this_month" } },
    { ask: "Chart my food spending by week", query: { measure: "spending", by: "week", category: "Food", period: "this_month" } },
    { ask: "Pie chart of this month", query: { measure: "spending", by: "category", style: "donut", period: "this_month" } },
    { ask: "Income minus spending since June, as a line", query: { measure: "net", by: "month", style: "line", period: null, startDate: "2026-06-01", endDate: "2026-11-30" } },
    { ask: "Where does my food money go? As a table", query: { measure: "spending", by: "merchant", style: "table", category: "Food", period: "this_month", compare: true } },
    { ask: "Daily spending this month", query: { measure: "spending", by: "day", period: "this_month" } },
  ];
  const samples = queries.flatMap(({ ask, query }) => {
    const drawn = drawChart({ query, transactions: books, userId: "sample", currency: "GHS", today });
    return drawn.ok ? [{ ask, chart: drawn.chart as DrawnChart }] : [];
  });
  return <ChartsPreview samples={samples} />;
}
