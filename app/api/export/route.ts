import { logError } from "@/lib/log";
import { fail, requireOwner } from "@/lib/web/api";

const COLUMNS = ["date", "type", "amount", "currency", "category", "description", "payment_method", "notes"] as const;

function cell(value: string): string {
  // Quote every cell and neutralise spreadsheet formulas.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export async function GET(): Promise<Response> {
  const owner = await requireOwner();
  if (owner instanceof Response) return owner;
  try {
    const rows = (await owner.store.listTransactions(owner.profile.profileId))
      .filter((item) => item.status === "active")
      .sort((left, right) => left.transactionDate.localeCompare(right.transactionDate));
    const lines = [
      COLUMNS.join(","),
      ...rows.map((item) =>
        [item.transactionDate, item.type, item.amount, item.currency, item.category, item.description, item.paymentMethod, item.notes]
          .map(cell)
          .join(","),
      ),
    ];
    return new Response(`${lines.join("\r\n")}\r\n`, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="alfred-transactions.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    logError("export", error);
    return fail("The export could not be prepared.", 500);
  }
}
