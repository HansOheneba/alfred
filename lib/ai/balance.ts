import { alertOperator } from "@/lib/ai/operator-alert";
import { logError, logInfo } from "@/lib/log";

/** Below this many US dollars of DeepSeek credit, the daily check warns. */
export const LOW_BALANCE_USD = 1;

export type BalanceCheck = { state: "ok" | "low" | "empty" | "unknown"; usd: number | null };

function readBalance(body: unknown): { available: boolean; usd: number | null } | null {
  if (!body || typeof body !== "object") return null;
  const { is_available: available, balance_infos: infos } = body as { is_available?: unknown; balance_infos?: unknown };
  if (typeof available !== "boolean" || !Array.isArray(infos)) return null;
  const usd = infos.find((info) => info && typeof info === "object" && (info as { currency?: unknown }).currency === "USD") as { total_balance?: unknown } | undefined;
  const amount = usd ? Number(usd.total_balance) : NaN;
  return { available, usd: Number.isFinite(amount) ? amount : null };
}

/**
 * Reads DeepSeek's remaining credit and warns the operator before it runs
 * out, rather than after people's messages start failing. Never throws.
 */
export async function checkModelBalance(
  apiKey: string | undefined,
  options: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<BalanceCheck> {
  if (!apiKey) return { state: "unknown", usd: null };
  let balance: ReturnType<typeof readBalance>;
  try {
    const response = await (options.fetchImpl ?? fetch)("https://api.deepseek.com/user/balance", {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`DeepSeek balance check failed with status ${response.status}.`);
    balance = readBalance(await response.json());
    if (!balance) throw new Error("DeepSeek balance reply had an unexpected shape.");
  } catch (error) {
    logError("ai_balance_unknown", error);
    return { state: "unknown", usd: null };
  }
  const { available, usd } = balance;
  const state: BalanceCheck["state"] = !available || (usd !== null && usd <= 0) ? "empty" : usd !== null && usd < LOW_BALANCE_USD ? "low" : "ok";
  logInfo("ai_balance", { state, usd: usd ?? -1 });
  if (state === "empty") {
    logError("ai_out_of_credit", new Error("DeepSeek reports no usable credit."));
    await alertOperator("ai_balance_empty", "DeepSeek has no credit left. Alfred can't read chat messages until it's topped up.", options);
  } else if (state === "low") {
    await alertOperator("ai_balance_low", `DeepSeek credit is down to $${usd!.toFixed(2)}. Top up soon, or Alfred will stop reading chat messages.`, options);
  }
  return { state, usd };
}
