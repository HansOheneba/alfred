"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, Card } from "@/app/components/ui";
import { Select } from "@/app/components/select";
import { requestMutationJson } from "@/app/components/mutation-request";
import { formatMinor } from "@/lib/finance/money";
import { daysLabel, ordinal, shortDate, type Payday, type PaydayForecast } from "@/lib/finance/payday";
import "./payday-card.css";

const DAYS = Array.from({ length: 31 }, (_, index) => index + 1);

/** What's left before payday. A learned payday asks to be confirmed; every figure comes from the server. */
export function PaydayCard({ payday, forecast }: { payday: Payday; forecast: PaydayForecast | null }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState(String(forecast?.day ?? 25));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (payday.status === "none") return null;

  async function save(day: number | null) {
    setSaving(true);
    setError(null);
    try {
      const result = await requestMutationJson<{ ok?: boolean; text?: string }>("/api/payday", "POST", { day });
      if (result?.ok === false) throw new Error(result.text ?? "Payday couldn't be saved.");
      setEditing(false);
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Payday couldn't be saved.");
    } finally {
      setSaving(false);
    }
  }

  const picker = (
    <div className="alfred-payday-picker">
      <Select label="Payday" value={choice} onChange={(event) => setChoice(event.target.value)} disabled={saving}>
        {DAYS.map((day) => <option key={day} value={String(day)}>The {ordinal(day)}</option>)}
        <option value="none">No regular payday</option>
      </Select>
      <Button size="sm" variant="primary" disabled={saving} onClick={() => void save(choice === "none" ? null : Number(choice))}>{saving ? "Saving…" : "Save"}</Button>
      {forecast ? <Button size="sm" variant="ghost" disabled={saving} onClick={() => setEditing(false)}>Cancel</Button> : null}
    </div>
  );

  if (!forecast) {
    return (
      <Card title="Before payday" className="alfred-payday">
        <p className="alfred-payday-note">Tell Alfred the day your salary usually lands, and this shows what&apos;s left after bills until then. Labelling your salary when it arrives works too.</p>
        {picker}
        {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
      </Card>
    );
  }

  const money = (minor: number) => formatMinor(minor, forecast.currency);
  const priced = forecast.bills.filter((bill) => bill.minor !== null);
  const when = forecast.days === 0 ? "Today" : `${shortDate(forecast.paydayDate)} · ${daysLabel(forecast.days)}`;
  return (
    <Card title="Before payday" action={<span className="alfred-payday-when">{when}</span>} className="alfred-payday">
      {forecast.leftMinor === null ? (
        <p className="alfred-payday-note">
          {forecast.cashMissing > 0
            ? `Waiting for a balance from ${forecast.cashMissing === 1 ? "one account" : `${forecast.cashMissing} accounts`}. A bank text with a balance fills this in.`
            : "No account has a balance from a bank text yet."}
        </p>
      ) : (
        <div className="alfred-payday-figure" data-tight={forecast.tight || undefined}>
          <p className="alfred-payday-left">{forecast.tight ? money(-forecast.leftMinor) : money(forecast.leftMinor)}</p>
          <p className="alfred-payday-caption">
            {forecast.tight
              ? `short: bills before payday come to ${money(forecast.billsMinor)}`
              : priced.length ? `left after ${priced.length === 1 ? "1 bill" : `${priced.length} bills`} (${money(forecast.billsMinor)})` : "left, with no bills due before payday"}
          </p>
        </div>
      )}
      {forecast.perDayMinor !== null || forecast.usualDailyMinor !== null ? (
        <p className="alfred-payday-daily">
          {forecast.perDayMinor !== null ? <>About <strong>{money(forecast.perDayMinor)}</strong> a day until payday</> : null}
          {forecast.perDayMinor !== null && forecast.usualDailyMinor !== null ? " · " : null}
          {forecast.usualDailyMinor !== null ? <>{forecast.perDayMinor !== null ? "you" : "You"}&apos;ve been spending about {money(forecast.usualDailyMinor)} a day</> : null}
        </p>
      ) : null}
      {priced.length ? (
        <ul className="alfred-payday-bills" aria-label="Bills due before payday">
          {priced.slice(0, 5).map((bill) => <li key={`${bill.name}-${bill.date}`}><span>{bill.name}</span><span>{shortDate(bill.date)}</span><span className="tabular-nums">{money(bill.minor!)}</span></li>)}
          {priced.length > 5 ? <li className="alfred-payday-more">and {priced.length - 5} more</li> : null}
        </ul>
      ) : null}
      {forecast.unpricedBills ? <p className="alfred-payday-note">{forecast.unpricedBills === 1 ? "One bill varies" : `${forecast.unpricedBills} bills vary`} in amount and isn&apos;t counted.</p> : null}
      {editing ? picker : forecast.status === "learned" ? (
        <div className="alfred-payday-confirm">
          <p>Payday looks like the {ordinal(forecast.day)}, from your salary in the last {forecast.learnedFrom} months. Is that right?</p>
          <div className="alfred-payday-actions">
            <Button size="sm" variant="primary" disabled={saving} onClick={() => void save(forecast.day)}>{saving ? "Saving…" : "Yes, that's right"}</Button>
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setEditing(true)}>Change</Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="ghost" className="alfred-payday-change" onClick={() => setEditing(true)}>Payday: the {ordinal(forecast.day)} · Change</Button>
      )}
      {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
    </Card>
  );
}
