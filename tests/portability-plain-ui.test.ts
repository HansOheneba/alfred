import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PortabilitySection, type PortabilityTransport } from "@/app/settings/portability-section";
import { plainImportMessage, specificImportWarnings } from "@/app/settings/portability-copy";

const transport = {} as PortabilityTransport;

describe("plain data transfer interface", () => {
  it("starts with a download and file review, without technical instructions or a false success", () => {
    const markup = renderToStaticMarkup(createElement(PortabilitySection, { transport }));
    expect(markup).toContain("Your data");
    expect(markup).toContain("Download my data");
    expect(markup).toContain("Import data");
    expect(markup).toContain("Choose a ZIP file");
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Review import<\/button>/);
    expect(markup).not.toContain("Confirm import");
    expect(markup).not.toContain("Your data is ready");
    for (const technical of ["schema", "SQL", "Postgres", "adapter", "Archive:", "Receipt:", "Dataset coverage", "JSON"]) expect(markup).not.toContain(technical);
  });

  it("shows specific safety warnings once and leaves the general reminder warning to the plain footer", () => {
    expect(specificImportWarnings([
      "Historical imports do not configure future SMS collection or enable reminders.",
      "Existing records and non-default destination settings are never overwritten.",
      "Imported bills start paused. Resume them in Bills to enable scheduling and reminders.",
      "Imported bills start paused. Resume them in Bills to enable scheduling and reminders.",
    ])).toEqual(["Imported bills start paused. Resume them in Bills to enable scheduling and reminders."]);
  });

  it("keeps invalid-file, duplicate, stale and ownership problems actionable without internal identifiers", () => {
    expect(plainImportMessage("Invalid source provenance.")).toContain("cannot be imported safely");
    expect(plainImportMessage("Invalid JSON in datasets/accounts.json.")).toContain("This file could not be read");
    expect(plainImportMessage("Checksum mismatch for datasets/accounts.json.")).not.toContain("datasets/accounts.json");
    expect(plainImportMessage("Complete source records are saved with their original identities and relationships. Feature-specific activation is limited to the deterministic adapters shown in a fresh review.")).toBe("Your original records stay saved. You can download the complete data at any time.");
    expect(plainImportMessage("Original portfolio records are saved for later.")).not.toContain("This request could not be checked");
    expect(plainImportMessage("Invalid request origin.")).toContain("This request could not be checked");
    expect(plainImportMessage("Source prompt, digest and notification preferences are saved.")).toBe("These reminder choices don’t have a matching feature in Alfred yet. They stay saved, and no reminders have been turned on.");
    expect(plainImportMessage("Alfred has no equivalent third-party allocation feature. Groups and audit remain lossless evidence.")).toBe("Shared money records stay saved until Alfred supports them. They haven’t been added to your spending.");
    expect(plainImportMessage("Account exclusion notes affect future SMS filtering and are retained as evidence without changing collection rules.")).toBe("These bank-message preferences stay saved. Your account filters haven’t changed.");
    expect(plainImportMessage("Safe default profile fields may already be applied. Original source account controls and reminder enables remain saved.")).toBe("Supported preferences were included in your review. Other settings stay saved; your connections and reminder choices are unchanged.");
    expect(plainImportMessage("Invalid ZIP central directory signature.")).toBe("This file could not be read. Download your data again, then choose the new ZIP file.");
    expect(plainImportMessage("Choose the approved fictional Money demo export. Personal finance files are not accepted here.")).toContain("sample download");
    expect(plainImportMessage("Data import requires the reviewed portability database migration. No financial records were changed.")).toBe("Import is not available yet. Your data has not changed.");
    const conflict = plainImportMessage("bills: record 00000000-0000-4000-8000-000000000123 differs from an existing destination record.");
    expect(conflict).toContain("differs");
    expect(conflict).not.toContain("00000000");
    const stale = "Financial records changed after this preview or import. Refresh and preview again; undo will never discard later edits.";
    expect(plainImportMessage(stale)).toContain("never discard later edits");
    expect(plainImportMessage("That receipt does not belong to this signed-in profile.")).toContain("does not belong");
  });
});
