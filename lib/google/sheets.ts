import { z } from "zod";

import { LIMITS } from "@/lib/config";
import { SheetsError } from "@/lib/errors";

const RANGE_PATTERN = /^[A-Za-z0-9_]+![A-Z]+[0-9]*(?::[A-Z]+[0-9]*)?$/;
const SPREADSHEET_ID_PATTERN = /^[a-zA-Z0-9-_]{20,128}$/;

const appendSchema = z.object({
  updates: z
    .object({
      updatedRange: z.string().optional(),
    })
    .optional(),
});

const titlesSchema = z.object({
  sheets: z
    .array(
      z.object({
        properties: z.object({ title: z.string() }).optional(),
      }),
    )
    .optional(),
});

const valuesSchema = z.object({
  values: z.array(z.array(z.union([z.string(), z.number(), z.boolean()]))).optional(),
});

export type SheetsClient = {
  getSheetTitles(): Promise<string[]>;
  addSheet(title: string): Promise<void>;
  getValues(range: string): Promise<string[][]>;
  updateValues(range: string, values: string[][]): Promise<void>;
  appendValues(range: string, values: string[][]): Promise<{ updatedRange: string | null }>;
};

function assertRange(range: string): void {
  if (!RANGE_PATTERN.test(range)) {
    throw new SheetsError("unavailable", "Refusing an unexpected sheet range.");
  }
}

async function sheetsError(response: Response): Promise<SheetsError> {
  let code = response.status;
  let status = "";
  try {
    const body = (await response.json()) as { error?: { code?: number; status?: string } };
    code = body.error?.code ?? code;
    status = body.error?.status ?? "";
  } catch {
    status = "";
  }
  if (code === 401 || status === "UNAUTHENTICATED") {
    return new SheetsError("credentials", "Google rejected the service account credentials.");
  }
  if (code === 403 || status === "PERMISSION_DENIED") {
    return new SheetsError("permission", "Google Sheets denied access.");
  }
  if (code === 404 || status === "NOT_FOUND") {
    return new SheetsError("not_found", "Google Sheets spreadsheet was not found.");
  }
  return new SheetsError("unavailable", `Google Sheets request failed with status ${code}.`);
}

export function createSheetsClient(input: {
  spreadsheetId: string;
  getAccessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}): SheetsClient {
  if (!SPREADSHEET_ID_PATTERN.test(input.spreadsheetId)) {
    throw new SheetsError("unavailable", "Refusing an unexpected spreadsheet id.");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${input.spreadsheetId}`;

  async function request(url: string, init: RequestInit): Promise<Response> {
    const token = await input.getAccessToken();
    try {
      return await fetchImpl(url, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(LIMITS.googleTimeoutMs),
      });
    } catch {
      throw new SheetsError("unavailable", "Google Sheets request timed out.");
    }
  }

  return {
    async getSheetTitles() {
      const response = await request(`${base}?fields=sheets.properties.title`, { method: "GET" });
      if (!response.ok) throw await sheetsError(response);
      const parsed = titlesSchema.safeParse(await response.json());
      if (!parsed.success) throw new SheetsError("unavailable", "Google Sheets returned an unexpected spreadsheet.");
      return (parsed.data.sheets ?? [])
        .map((sheet) => sheet.properties?.title)
        .filter((title): title is string => Boolean(title));
    },
    async addSheet(title) {
      if (!/^[A-Za-z0-9_]+$/.test(title)) {
        throw new SheetsError("unavailable", "Refusing an unexpected worksheet name.");
      }
      const response = await request(`${base}:batchUpdate`, {
        method: "POST",
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
      });
      if (!response.ok) throw await sheetsError(response);
    },
    async getValues(range) {
      assertRange(range);
      const response = await request(`${base}/values/${encodeURIComponent(range)}`, { method: "GET" });
      if (response.status === 400) return [];
      if (!response.ok) throw await sheetsError(response);
      const parsed = valuesSchema.safeParse(await response.json());
      if (!parsed.success) throw new SheetsError("unavailable", "Google Sheets returned unexpected values.");
      return (parsed.data.values ?? []).map((row) => row.map((cell) => String(cell)));
    },
    async updateValues(range, values) {
      assertRange(range);
      const response = await request(`${base}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
        method: "PUT",
        body: JSON.stringify({ range, majorDimension: "ROWS", values }),
      });
      if (!response.ok) throw await sheetsError(response);
    },
    async appendValues(range, values) {
      assertRange(range);
      const response = await request(
        `${base}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        {
          method: "POST",
          body: JSON.stringify({ range, majorDimension: "ROWS", values }),
        },
      );
      if (!response.ok) throw await sheetsError(response);
      const parsed = appendSchema.safeParse(await response.json());
      return { updatedRange: parsed.success ? (parsed.data.updates?.updatedRange ?? null) : null };
    },
  };
}
