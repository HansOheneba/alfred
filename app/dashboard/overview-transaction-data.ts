"use client";

import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ChatReadTimeout, chatReadDeadline } from "@/app/chat/read-deadline";
import { overviewTransactionQueryKey, overviewTransactionQueryParams, type OverviewTransactionPage, type OverviewTransactionQuery } from "@/lib/web/overview-transactions";

const rowSchema = z.object({
  id: z.string().min(1).max(512), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), type: z.enum(["income", "expense"]),
  minor: z.number().int().safe(), amount: z.string().max(40), currency: z.string().regex(/^[A-Z]{3}$/), category: z.string().max(200), description: z.string().max(10000), paymentMethod: z.string().max(1000),
  receipt: z.object({ kind: z.enum(["payment", "fee", "tax"]), accountLabel: z.string().nullable(), occurredAt: z.string().nullable(), status: z.enum(["confirmed", "review", "hold", "transfer", "duplicate", "excluded"]), sourceLabel: z.string(), principalMinor: z.number().int().safe(), feeMinor: z.number().int().safe(), taxMinor: z.number().int().safe(), balanceBeforeMinor: z.number().int().safe().nullable(), balanceAfterMinor: z.number().int().safe().nullable(), links: z.array(z.enum(["transfer", "refund", "loan"])), imported: z.boolean(), sourceMissing: z.boolean() }).optional(),
});
const pageSchema = z.object({ rows: z.array(rowSchema).max(15), total: z.number().int().nonnegative().safe(), nextCursor: z.string().max(1200).nullable(), version: z.string().regex(/^[a-f0-9]{64}$/), queryKey: z.string().max(600), categories: z.array(z.string().max(200)) });
export type RemoteOverviewTransactions = { ownerId: string; initialPage: OverviewTransactionPage };
export class OverviewReadChanged extends Error {
  constructor() { super("Your financial records changed. Refresh Overview before loading more transactions."); }
}

/** Only GETs, bounded through response decoding; late or cross-session results never publish. */
export async function readOverviewTransactions(config: RemoteOverviewTransactions, query: OverviewTransactionQuery, cursor: string | null, signal: AbortSignal, request: typeof fetch = fetch): Promise<OverviewTransactionPage> {
  const params = overviewTransactionQueryParams(query);
  if (cursor) params.set("cursor", cursor);
  const controller = new AbortController(), cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) controller.abort();
  try {
    return await chatReadDeadline((async () => {
      const response = await request(`/api/overview/transactions?${params}`, { method: "GET", credentials: "same-origin", cache: "no-store", signal: controller.signal });
      const payload = await response.json();
      if (response.status === 409 && payload?.stale === true) throw new OverviewReadChanged();
      if (!response.ok || payload?.ok !== true) throw new Error(typeof payload?.text === "string" ? payload.text : "Your transactions could not be loaded. Please try again.");
      if (payload.ownerId !== config.ownerId) throw new Error("Your signed-in account changed. Reload Overview before continuing.");
      const parsed = pageSchema.safeParse(payload.page);
      if (!parsed.success || parsed.data.queryKey !== overviewTransactionQueryKey(query)) throw new Error("Your transaction response could not be verified. Please reload Overview.");
      if (parsed.data.version !== config.initialPage.version) throw new OverviewReadChanged();
      return parsed.data;
    })(), 20_000, signal, cancel);
  } catch (error) {
    if (error instanceof ChatReadTimeout) throw new Error("Your transactions took too long to load. Please try again.");
    if (signal.aborted) throw new Error("The transaction read was cancelled.");
    throw error;
  } finally { signal.removeEventListener("abort", cancel); }
}

type ReadState = { ownerId: string; version: string; queryKey: string; attempt: number; page: OverviewTransactionPage; loading: boolean; error: string; stale: boolean };
export function useOverviewTransactionPage(config: RemoteOverviewTransactions | undefined, query: OverviewTransactionQuery) {
  const key = overviewTransactionQueryKey(query), ownerId = config?.ownerId, version = config?.initialPage.version;
  const [state, setState] = useState<ReadState | null>(null), [retry, setRetry] = useState(0);
  const more = useRef(false), active = useRef<AbortController | null>(null);
  const current = config && state && state.ownerId === ownerId && state.version === version && state.queryKey === key && state.attempt === retry ? state : null;
  const initial = retry === 0 && config?.initialPage.queryKey === key ? config.initialPage : null;
  const page = current?.page ?? initial;

  useEffect(() => {
    if (!config) return;
    active.current?.abort(); active.current = null;
    if (key === config.initialPage.queryKey && retry === 0) return;
    const controller = new AbortController();
    active.current = controller;
    const empty: OverviewTransactionPage = { rows: [], total: 0, categories: [], nextCursor: null, version: config.initialPage.version, queryKey: key };
    void readOverviewTransactions(config, query, null, controller.signal).then(result => {
      if (!controller.signal.aborted) setState({ ownerId: config.ownerId, version: config.initialPage.version, queryKey: key, attempt: retry, page: result, loading: false, error: "", stale: false });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ ownerId: config.ownerId, version: config.initialPage.version, queryKey: key, attempt: retry, page: empty, loading: false, error: error instanceof Error ? error.message : "Your transactions could not be loaded.", stale: error instanceof OverviewReadChanged });
    });
    return () => controller.abort();
    // The primitive key encodes every query field; object identity is not a read-cache key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerId, version, key, retry]);
  useEffect(() => () => active.current?.abort(), []);

  async function loadMore() {
    if (!config || !page?.nextCursor || more.current) return;
    more.current = true;
    const controller = new AbortController(); active.current?.abort(); active.current = controller;
    const base: ReadState = { ownerId: config.ownerId, version: config.initialPage.version, queryKey: key, attempt: retry, page, loading: true, error: "", stale: false };
    setState(base);
    try {
      const result = await readOverviewTransactions(config, query, page.nextCursor, controller.signal);
      if (!controller.signal.aborted) {
        if (result.total !== page.total || result.rows.some(row => page.rows.some(prior => prior.id === row.id))) throw new OverviewReadChanged();
        setState({ ...base, page: { ...result, rows: [...page.rows, ...result.rows] }, loading: false });
      }
    } catch (error) {
      if (!controller.signal.aborted) setState({ ...base, loading: false, error: error instanceof Error ? error.message : "Your transactions could not be loaded.", stale: error instanceof OverviewReadChanged });
    } finally { more.current = false; }
  }
  return config ? { page, loading: current?.loading ?? !initial, error: current?.error ?? "", stale: current?.stale ?? false, loadMore, retry: () => setRetry(value => value + 1) } : null;
}
