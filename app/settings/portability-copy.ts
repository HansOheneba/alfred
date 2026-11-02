/** Plain, actionable messages for data transfer. Internal identifiers stay in downloads. */
const GENERAL_IMPORT_WARNINGS = new Set([
  "Historical imports do not configure future SMS collection or enable reminders.",
  "Existing records and non-default destination settings are never overwritten.",
]);

export function specificImportWarnings(warnings: string[]): string[] {
  return [...new Set(warnings.filter((warning) => !GENERAL_IMPORT_WARNINGS.has(warning)).map(plainImportMessage))];
}

export function plainImportMessage(message: string): string {
  if (/Alfred has no equivalent third-party allocation feature/i.test(message)) return "Shared money records stay saved until Alfred supports them. They haven’t been added to your spending.";
  if (/Account exclusion notes affect future SMS filtering/i.test(message)) return "These bank-message preferences stay saved. Your account filters haven’t changed.";
  if (/Safe default profile fields may already be applied/i.test(message)) return "Supported preferences were included in your review. Other settings stay saved; your connections and reminder choices are unchanged.";
  if (message.startsWith("Complete source records are saved with their original identities and relationships.")) return "Your original records stay saved. You can download the complete data at any time.";
  if (/Source prompt, digest|payment prompts, weekly summaries|reminder opt-ins/i.test(message)) return "These reminder choices don’t have a matching feature in Alfred yet. They stay saved, and no reminders have been turned on.";
  if (/Equivalent destination features|source-specific gaps|Raw cash source|historical import operations|raw snapshot|bank-message foreign keys|source provenance|accounting audit|source archive/i.test(message) && !/invalid|conflict|differs|missing|mismatch|failed|cannot|unsafe/i.test(message)) return "These original records stay saved in your full download.";
  if (/stable IDs|stable identities|accounting core/i.test(message) && !/invalid|conflict|missing/i.test(message)) return "These records can be added to Alfred.";
  if (/retained archive wrappers|documented wrappers|nesting levels/i.test(message)) return "Some older imports are saved for download and need another review before they can be used.";
  if (/approved fictional|Personal finance files are not accepted/i.test(message)) return "This demo accepts the sample download from Money Tracker or Alfred. Choose that file to continue.";
  if (/adapter/i.test(message) && /future|required|unavailable|missing|not|awaiting/i.test(message)) return "This type of record isn’t supported yet. Your data stays saved.";
  if (/migration|database.*unavailable/i.test(message)) return "Import is not available yet. Your data has not changed.";
  if (/five pending import previews|Too many pending/i.test(message)) return "You have several unfinished reviews. Finish one or try again later.";
  if (/invalid JSON|checksum mismatch|invalid manifest|missing manifest|unsupported compression|unexpected token/i.test(message) || /ZIP|archive/i.test(message) && /invalid|malformed|signature|central directory|truncated|checksum|digest|corrupt|schema|manifest|unsupported.*version|Unexpected|not.*valid/i.test(message)) return "This file could not be read. Download your data again, then choose the new ZIP file.";
  if (/ZIP|archive/i.test(message) && /limit|larger|too (?:large|many)|size|compress|traversal|entry|path/i.test(message)) return "This file cannot be imported. Choose a supported ZIP file up to 20 MB.";
  if (/\b(?:origin|same-origin|loopback|host|cross-site)\b/i.test(message)) return "This request could not be checked. Reload this page and try again.";
  if (/native|schema|provenance|foreign key|mapped identity|source overlap|bank_message_id|source IDs?/i.test(message)) {
    if (/different|differs|conflict|overlap|already/i.test(message)) return "Some records conflict with data already in Alfred. Nothing will be overwritten. Check the original app before trying again.";
    if (/missing|invalid|unsupported/i.test(message)) return "Some records are incomplete or cannot be imported safely. Nothing has been changed.";
  }
  if (/WebLocks|navigator\.locks|localStorage|cookie|device journal|journal/i.test(message)) return "Your device settings could not be saved safely. Your financial data is kept; check your appearance and privacy settings before trying to undo.";
  return message
    .replace(/\b(?:alfred|moneyTracker|money-tracker)\.[\w.-]+/g, "saved data")
    .replace(/\b(?:profile|reminders)\.([a-z_]+)/g, (_, field: string) => ({ preferred_name: "Name", currency: "Currency", timezone: "Timezone", communication_preference: "Reply preference", financial_goals: "Financial goals", account_names: "Bank message settings", morning_minute: "Morning reminder", commute_minute: "Commute reminder", evening_minute: "Evening reminder" }[field] || "Settings"))
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "this record")
    .replace(/\b[0-9a-f]{32,64}\b/gi, "this record")
    .replace(/\b(?:destination|signed-in profile)\b/gi, "Alfred")
    .replace(/\b(?:archive|dataset)\b/gi, "file")
    .replace(/\bpreview\b/gi, "review")
    .replace(/\bnative\s+/gi, "")
    .replace(/\bre-export\b/gi, "download")
    .replace(/\bsource evidence\b/gi, "original records")
    .replace(/\b(?:adapter|provenance|schema|source fingerprint|atomic commit)\b/gi, "import support")
    .replace(/\bnon-default\b/g, "custom")
    .replace(/\brecord ([^\s:]{30,})/gi, "a record");
}
