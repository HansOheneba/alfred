"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

import type { CategoryRecord } from "@/lib/finance/types";

const CategoryCatalog = createContext<readonly CategoryRecord[]>([]);
const RefreshCategories = createContext<() => void>(() => {});
export const CATEGORY_SESSION_CHANGED = "Your session changed. Reload this page to continue.";

/** Category names are private owner data, including when a session changes during a request. */
export async function loadOwnedCategories(ownerId: string, signal: AbortSignal, request: typeof fetch = fetch): Promise<CategoryRecord[]> {
  const response = await request("/api/categories", { cache: "no-store", credentials: "same-origin", signal });
  const payload = await response.json() as { ok?: boolean; ownerId?: string; categories?: CategoryRecord[] };
  if (payload.ownerId !== ownerId) throw new Error(CATEGORY_SESSION_CHANGED);
  if (!response.ok || payload.ok !== true || !Array.isArray(payload.categories)) throw new Error("Your categories could not be loaded.");
  if (payload.categories.some(item => !item || item.userId !== ownerId || typeof item.categoryId !== "string" || typeof item.name !== "string" || !item.name.trim() || item.name.length > 40 || (item.type !== "expense" && item.type !== "income"))) {
    throw new Error("Your categories could not be loaded.");
  }
  return payload.categories;
}

/** A remounted owner boundary keeps category suggestions out of another session. */
export function CategoryCatalogProvider({ ownerId, refreshKey, children }: { ownerId?: string; refreshKey: string; children?: ReactNode }) {
  return <OwnedCategoryCatalog key={ownerId ?? "signed-out"} ownerId={ownerId} refreshKey={refreshKey}>{children}</OwnedCategoryCatalog>;
}

function OwnedCategoryCatalog({ ownerId, refreshKey, children }: { ownerId?: string; refreshKey: string; children?: ReactNode }) {
  const [categories, setCategories] = useState<CategoryRecord[]>([]);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion(value => value + 1), []);
  useEffect(() => {
    if (!ownerId) return;
    const controller = new AbortController();
    let latestRequest = 0;
    const load = () => {
      const requestNumber = ++latestRequest;
      void loadOwnedCategories(ownerId, controller.signal).then(result => {
        if (!controller.signal.aborted && requestNumber === latestRequest) setCategories(result);
      }).catch(() => {
        // Built-in suggestions remain available while the catalog cannot be read.
        if (!controller.signal.aborted && requestNumber === latestRequest) setCategories([]);
      });
    };
    load();
    window.addEventListener("focus", load);
    return () => { controller.abort(); window.removeEventListener("focus", load); };
  }, [ownerId, refreshKey, version]);
  return <CategoryCatalog.Provider value={categories}><RefreshCategories.Provider value={refresh}>{children}</RefreshCategories.Provider></CategoryCatalog.Provider>;
}

export function useCustomCategories(): readonly CategoryRecord[] { return useContext(CategoryCatalog); }
/** Chat refreshes this owner's suggestions after a confirmed write or uncertain legacy outcome. */
export function useRefreshCategories(): () => void { return useContext(RefreshCategories); }
