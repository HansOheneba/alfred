import type { StudioDeps } from "@/lib/studio/handle";

/** One turn's read snapshot and confirmed writes. Never shared between requests or owners. */
export function trackTurnData(deps: StudioDeps) {
  let changed = false;
  const reads = new Map<string, Promise<unknown>>();
  const invalidate = () => { changed = true; reads.clear(); };

  function observe<T extends object>(store: T, name: string, writes: readonly (keyof T)[], cached: readonly (keyof T)[] = []): T {
    return new Proxy(store, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        const method = property as keyof T;
        if (!writes.includes(method) && !cached.includes(method)) return value.bind(target);
        return (...args: unknown[]) => {
          const key = `${name}:${String(property)}:${JSON.stringify(args)}`;
          if (cached.includes(method) && reads.has(key)) return reads.get(key);
          const result = Promise.resolve().then(() => Reflect.apply(value, target, args)).then((saved: unknown) => {
            // False/null explicitly mean no matching record or no inserted source.
            const patch = args[2];
            const emptyPatch = ["update", "updateTransaction", "updateSavingsGoal", "updateMessage"].includes(String(property)) && patch && typeof patch === "object" && !Object.values(patch).some((item) => item !== undefined);
            const emptyHoldings = property === "setHoldings" && Array.isArray(patch) && patch.length === 0;
            const unchanged = saved === false || saved === null || saved === "stale" || saved === "missing" || saved === "already_applied"
              || typeof saved === "object" && saved !== null && "availability" in saved && saved.availability !== "ready";
            if (writes.includes(method) && !emptyPatch && !emptyHoldings && !unchanged) invalidate();
            return saved;
          });
          if (cached.includes(method)) reads.set(key, result);
          return result;
        };
      },
    });
  }

  return {
    changed: () => changed,
    deps: {
      ...deps,
      store: observe(deps.store, "finance", ["appendTransaction", "updateTransaction", "saveBudget", "deleteBudget", "createCategory", "appendSavingsGoal", "updateSavingsGoal"], ["listTransactions", "listReportTransactions", "readReporting", "listBudgets", "listSavingsGoals", "listCategories"]),
      bills: deps.bills ? observe(deps.bills, "bills", ["save", "setActive", "remove", "applyConfirmed"], ["list", "strictList"]) : deps.bills,
      accountManagement: deps.accountManagement ? observe(deps.accountManagement, "accountManagement", ["save"], ["read"]) : deps.accountManagement,
      preferences: deps.preferences ? observe(deps.preferences, "preferences", ["updateProfile", "updateReminders", "updateNotifications"], ["readProfile", "readReminders", "readNotifications"]) : deps.preferences,
      bank: deps.bank ? observe(deps.bank, "bank", ["insertMessage", "updateMessage", "correctDate", "saveRule", "deleteRule", "addAccountName"]) : deps.bank,
      loans: deps.loans ? observe(deps.loans, "loans", ["add", "remove"], ["list"]) : deps.loans,
      investments: deps.investments ? observe(deps.investments, "investments", ["create", "update", "setHoldings", "addValue", "addContribution", "removeContribution"]) : deps.investments,
      // A note tied to an account can hide that account's balances from the ledger.
      notebook: deps.notebook ? {
        ...deps.notebook,
        list: deps.notebook.list.bind(deps.notebook),
        add: async (...args: Parameters<typeof deps.notebook.add>) => {
          const saved = await deps.notebook!.add(...args);
          if (args[1].account) invalidate();
          return saved;
        },
        remove: async (...args: Parameters<typeof deps.notebook.remove>) => {
          await deps.notebook!.remove(...args);
          invalidate();
        },
      } : deps.notebook,
      accountRuleCommands: deps.accountRuleCommands ? {
        ...deps.accountRuleCommands,
        save: async (...args: Parameters<typeof deps.accountRuleCommands.save>) => {
          const result = await deps.accountRuleCommands!.save(...args);
          if (result.availability === "ready") invalidate();
          return result;
        },
      } : deps.accountRuleCommands,
      transferConversations: deps.transferConversations ? {
        ...deps.transferConversations,
        inspect: deps.transferConversations.inspect.bind(deps.transferConversations),
        confirm: async (...args: Parameters<typeof deps.transferConversations.confirm>) => {
          const result = await deps.transferConversations!.confirm(...args);
          if (result.changed) invalidate();
          return result;
        },
        reject: async (...args: Parameters<typeof deps.transferConversations.reject>) => {
          const result = await deps.transferConversations!.reject(...args);
          if (result.changed) invalidate();
          return result;
        },
      } : deps.transferConversations,
      paymentResolutions: deps.paymentResolutions ? {
        inspect: deps.paymentResolutions.inspect.bind(deps.paymentResolutions),
        noMoney: async (...args: Parameters<typeof deps.paymentResolutions.noMoney>) => { const result=await deps.paymentResolutions!.noMoney(...args);if(result.changed)invalidate();return result; },
        returned: async (...args: Parameters<typeof deps.paymentResolutions.returned>) => { const result=await deps.paymentResolutions!.returned(...args);if(result.changed)invalidate();return result; },
        reopen: async (...args: Parameters<typeof deps.paymentResolutions.reopen>) => { const result=await deps.paymentResolutions!.reopen(...args);if(result.changed)invalidate();return result; },
      } : deps.paymentResolutions,
    } satisfies StudioDeps,
  };
}
