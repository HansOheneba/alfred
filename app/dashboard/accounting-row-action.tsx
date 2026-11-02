import Link from "next/link";

export function isAccountingRow(id: string) { return /^accounting(?:-fee)?:/.test(id); }

export function AccountingRowAction({ preview = false }: { preview?: boolean }) {
  return <Link href={`${preview ? "/ui-preview" : ""}/accounts?tab=activity`} className="inline-flex min-h-8 items-center rounded-lg px-2 text-xs text-accent hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-accent">Manage in Accounts ↗</Link>;
}
