import Link from "next/link";
import { buttonClassName } from "@/app/components/button-styles";

export function isAccountingRow(id: string) { return /^accounting(?:-fee)?:/.test(id); }

export function AccountingRowAction({ preview = false }: { preview?: boolean }) {
  return <Link href={`${preview ? "/ui-preview" : ""}/accounts?tab=activity`} className={buttonClassName({ variant: "ghost", size: "sm" })}>Manage in Accounts ↗</Link>;
}
