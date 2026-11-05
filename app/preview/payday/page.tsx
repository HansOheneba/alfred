import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { PaydayCard } from "@/app/dashboard/payday-card";
import type { BillRecord } from "@/lib/finance/bills";
import { forecastPayday, type Payday } from "@/lib/finance/payday";
import type { TransactionRecord } from "@/lib/finance/types";
import { automationPreviewAllowed } from "@/lib/preview/access";

export const metadata: Metadata = { title: "Payday preview · Alfred", robots: { index: false, follow: false } };

export default function PaydayPreviewPage() {
  return <Suspense fallback={<p className="p-8 text-sm text-muted">Working out the sample paydays…</p>}><LocalPreview /></Suspense>;
}

const today = "2026-11-15";
const spend = (date: string, amount: string): TransactionRecord => ({
  transactionId: `sample-${date}-${amount}`, createdAt: `${date}T12:00:00.000Z`, transactionDate: date, userId: "sample", type: "expense", amount, currency: "GHS", category: "Food", description: "Waakye",
  paymentMethod: "", notes: "", status: "active", updatedAt: `${date}T12:00:00.000Z`, sourceUpdateId: "sample", rowNumber: 0,
});
const bill = (name: string, nextDate: string, amount: string | null): BillRecord => ({
  id: name, ownerId: "sample", name, nextDate, amount, currency: "GHS", cadence: "monthly", active: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
});

/** Fictional books only: no real person, account or payment. */
async function LocalPreview() {
  await connection();
  if (!automationPreviewAllowed(process.env)) notFound();
  const bills = [bill("Rent share", "2026-11-20", "1500.00"), bill("Fibre", "2026-11-18", "350.00"), bill("ECG prepaid", "2026-11-19", null)];
  const transactions = [spend("2026-11-02", "1800.00"), spend("2026-11-12", "1500.00")];
  const learned: Payday = { status: "learned", day: 25, months: 3, lastPaid: "2026-10-23" };
  const confirmed: Payday = { status: "confirmed", day: 25 };
  const samples: { title: string; payday: Payday; cash: number | null }[] = [
    { title: "Learned from salary, waiting to be confirmed", payday: learned, cash: 2_670_00 },
    { title: "Confirmed, and bills come to more than what's there", payday: confirmed, cash: 1_000_00 },
    { title: "An account has no balance from a bank text yet", payday: confirmed, cash: null },
    { title: "No payday known yet", payday: { status: "unknown" }, cash: 2_670_00 },
  ];
  return (
    <main className="mx-auto grid max-w-xl gap-8 px-4 py-10">
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold">Before payday</h1>
        <p className="text-sm text-muted">Fictional books, today {today}. Buttons here don&apos;t save anything.</p>
      </header>
      {samples.map(({ title, payday, cash }) => (
        <section key={title} className="grid gap-2">
          <p className="text-xs text-muted">{title}</p>
          <PaydayCard payday={payday} forecast={forecastPayday({ payday, today, currency: "GHS", cash: { totalMinor: cash, missingCount: cash === null ? 1 : 0 }, bills, transactions })} />
        </section>
      ))}
    </main>
  );
}
