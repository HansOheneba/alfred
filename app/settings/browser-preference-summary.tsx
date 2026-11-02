import type { BrowserPreferenceChange, BrowserPreferencePlan, BrowserPreferenceReceipt } from "@/lib/portability/browser-preferences";
import { plainImportMessage } from "@/app/settings/portability-copy";

const fieldLabels = { appearance: "Appearance", privacy: "Amounts on screen", home: "Start screen" };
const valueLabels: Record<string, string> = { light: "Light", dark: "Dark", visible: "Show amounts", masked: "Hide amounts", chat: "Chat", overview: "Overview" };

function Changes({ changes }: { changes: BrowserPreferenceChange[] }) {
  if (!changes.length) return <p className="text-xs text-muted">No device preference changes.</p>;
  return <dl className="space-y-2 text-xs leading-5">{changes.map((change) => <div key={change.field} className="flex flex-wrap justify-between gap-x-4 gap-y-1"><dt className="font-medium">{fieldLabels[change.field]}</dt><dd className="text-muted">{valueLabels[change.before] || "Current choice"} → {valueLabels[change.after] || "Imported choice"}</dd></div>)}</dl>;
}

function Warnings({ messages, danger = false }: { messages: string[]; danger?: boolean }) {
  if (!messages.length) return null;
  return <ul className={`list-disc space-y-1 pl-5 text-xs leading-5 ${danger ? "text-danger" : "text-muted"}`}>{[...new Set(messages.map(plainImportMessage))].map((message, index) => <li key={`${index}-${message}`} className="break-words">{message}</li>)}</ul>;
}

export function BrowserPreferenceReview({ plan }: { plan: BrowserPreferencePlan }) {
  return (
    <section aria-label="Device preference review" className="space-y-3 rounded-xl border border-line p-3">
      <h4 className="text-sm font-medium">Preferences on this device</h4>
      <p className="text-xs leading-5 text-muted">{plan.status === "blocked" ? "Your current preferences differ. Choose what to keep, then check the file again." : plan.status === "preserved" ? "Your finance records can still be imported. Device preferences will stay unchanged." : plan.status === "ready" ? "Review these device changes before importing." : "Device preferences already match."}</p>
      {plan.status === "preserved" ? <p className="text-xs text-muted">No device preference changes will be applied.</p> : <Changes changes={plan.changes} />}
      <Warnings messages={plan.conflicts} danger />
      <Warnings messages={plan.warnings} />
    </section>
  );
}

const receiptLabels: Record<BrowserPreferenceReceipt["status"], string> = {
  applied: "Device preferences applied", unchanged: "Device preferences unchanged", partial: "Device preference restoration needs attention", unknown: "Device preference outcome needs checking", undone: "Device preference changes undone",
  preserved: "Device preferences kept in your download",
};

export function BrowserPreferenceReceiptView({ receipt, undone = false }: { receipt: BrowserPreferenceReceipt; undone?: boolean }) {
  return (
    <section aria-label="Device preference receipt" className="space-y-3 rounded-xl border border-line p-3">
      <h4 className="text-sm font-medium">{receiptLabels[receipt.status]}</h4>
      {receipt.status === "partial" || receipt.status === "unknown" ? <p className="text-xs leading-5 text-muted">{undone ? "Your finance import was undone." : "Your finance records were imported."} Some device preferences still need attention.</p> : null}
      {receipt.status === "preserved" ? <p className="text-xs text-muted">No device preference changes were applied.</p> : <Changes changes={receipt.changes} />}
      <Warnings messages={receipt.warnings} />
      {receipt.undoBlocked ? <p className="text-xs leading-5 text-danger">Undo is unavailable while device settings need attention. Your later changes are kept.</p> : null}
    </section>
  );
}
