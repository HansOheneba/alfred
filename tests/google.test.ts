import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { SheetsError } from "@/lib/errors";
import { getGoogleAccessToken, resetAccessTokenCache, signServiceAccountJwt } from "@/lib/google/auth";
import { createGoogleFinanceStore, resetSheetsReadyCache } from "@/lib/google/finance-store";
import { createSheetsClient, type SheetsClient } from "@/lib/google/sheets";
import { expense } from "./helpers";

class FakeSheets implements SheetsClient {
  readonly sheets = new Map<string, string[][]>();
  headerWrites = 0;

  async getSheetTitles(): Promise<string[]> {
    return [...this.sheets.keys()];
  }

  async addSheet(title: string): Promise<void> {
    this.sheets.set(title, []);
  }

  async getValues(range: string): Promise<string[][]> {
    const title = range.split("!")[0] ?? "";
    const rows = this.sheets.get(title) ?? [];
    if (/!A1:[A-Z]+1$/.test(range)) return rows.slice(0, 1);
    return rows;
  }

  async updateValues(range: string, values: string[][]): Promise<void> {
    const title = range.split("!")[0] ?? "";
    const rows = this.sheets.get(title) ?? [];
    if (/!A1:[A-Z]+1$/.test(range)) {
      this.headerWrites += 1;
      if (rows.length === 0) this.sheets.set(title, [values[0] ?? []]);
      else rows[0] = values[0] ?? [];
      return;
    }
    const rowNumber = Number(/!A(\d+):/.exec(range)?.[1] ?? "0");
    while (rows.length < rowNumber) rows.push([]);
    rows[rowNumber - 1] = values[0] ?? [];
    this.sheets.set(title, rows);
  }

  async appendValues(range: string, values: string[][]): Promise<{ updatedRange: string | null }> {
    const title = range.split("!")[0] ?? "";
    const rows = this.sheets.get(title) ?? [];
    rows.push(values[0] ?? []);
    this.sheets.set(title, rows);
    return { updatedRange: null };
  }
}

describe("Google Sheets", () => {
  it("signs a service-account JWT without sending the private key as the token", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const email = "bot@example.iam.gserviceaccount.com";
    const jwt = signServiceAccountJwt(email, privateKey, 1_700_000_000);
    expect(jwt.split(".")).toHaveLength(3);
    expect(jwt).not.toContain("BEGIN PRIVATE KEY");
    resetAccessTokenCache();
    let body = "";
    const fetchImpl: typeof fetch = async (_url, init) => {
      const raw = init?.body;
      body = raw instanceof URLSearchParams ? raw.toString() : String(raw ?? "");
      return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }), { status: 200 });
    };
    const token = await getGoogleAccessToken(
      {
        clientEmail: email,
        privateKey,
        spreadsheetId: "sheet-configured-on-the-server-001",
      },
      fetchImpl,
      1_700_000_000_000,
    );
    expect(token).toBe("ya29.test");
    expect(decodeURIComponent(body)).not.toContain("BEGIN PRIVATE KEY");
    expect(body).toContain("grant_type=");
    expect(publicKey).toContain("BEGIN PUBLIC KEY");
  });

  it("maps a permission error and refuses a bad spreadsheet id", async () => {
    expect(() =>
      createSheetsClient({
        spreadsheetId: "not a sheet",
        getAccessToken: async () => "token",
      }),
    ).toThrow(SheetsError);
    const client = createSheetsClient({
      spreadsheetId: "sheet-configured-on-the-server-001",
      getAccessToken: async () => "token",
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED" } }), { status: 403 }),
    });
    await expect(client.getSheetTitles()).rejects.toMatchObject({ code: "permission" });
  });

  it("creates missing headers and does not overwrite a mismatched sheet", async () => {
    resetSheetsReadyCache();
    const fake = new FakeSheets();
    const store = createGoogleFinanceStore({
      spreadsheetId: "sheet-configured-on-the-server-001",
      client: fake,
    });
    await store.ensureReady();
    const writesAfterCreate = fake.headerWrites;
    expect(writesAfterCreate).toBeGreaterThan(0);
    await store.ensureReady();
    expect(fake.headerWrites).toBe(writesAfterCreate);

    resetSheetsReadyCache();
    const mismatched = new FakeSheets();
    mismatched.sheets.set("Transactions", [["wrong"]]);
    mismatched.sheets.set("Budgets", [["budget_id"]]);
    mismatched.sheets.set("SavingsGoals", [["goal_id"]]);
    mismatched.sheets.set("ProcessedUpdates", [["update_id"]]);
    mismatched.sheets.set("PendingActions", [["action_id"]]);
    const broken = createGoogleFinanceStore({
      spreadsheetId: "sheet-configured-on-the-server-002",
      client: mismatched,
    });
    await expect(broken.ensureReady()).rejects.toMatchObject({ code: "headers" });
    expect(mismatched.headerWrites).toBe(0);
  });

  it("confirms a transaction write by reading it back", async () => {
    resetSheetsReadyCache();
    const fake = new FakeSheets();
    const store = createGoogleFinanceStore({
      spreadsheetId: "sheet-configured-on-the-server-003",
      client: fake,
    });
    const saved = await store.appendTransaction(expense({ sourceUpdateId: "update:1:0" }));
    const rows = await store.listTransactions("42");
    expect(rows.map((row) => row.transactionId)).toEqual([saved.transactionId]);
    expect(rows[0]?.amount).toBe("45.00");
  });
});
