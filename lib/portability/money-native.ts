import { createHash } from "node:crypto";
import type { ImportArchive } from "./model";
import type { NativeRestoreSource } from "./native-restoration";
import type { ExportCoverage } from "./export";
import { normalizeRuleText, type AccountRule } from "@/lib/account-rules/types";

type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const minor = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
const money = (value: number) => `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
const instant = (value: unknown, fallback: string) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback;
const day = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const uuid = (namespace: string, sourceId: string) => { const hash = createHash("sha256").update(`${namespace}\0${sourceId}`).digest("hex"); return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`; };

/** Fixed mappings into existing Alfred features. Source-specific meanings remain explicit notes/evidence. */
export function moneyNativeSupplement(archive: ImportArchive): NativeRestoreSource | null {
  if (archive.manifest.sourceApp !== "money-tracker") return null;
  const source = archive.datasets["moneyTracker.native"];
  const native = object(source) ? source : {};
  const portfolioSource = archive.datasets["moneyTracker.portfolios"];
  if (!object(source) && !object(portfolioSource)) return null;
  const planning = object(native.planning) ? native.planning : {};
  const bills = object(native.bills) && Array.isArray(native.bills.bills) ? native.bills.bills : [];
  const at = instant(archive.manifest.exportedAt, "1970-01-01T00:00:00.000Z");
  const tables: Record<string, Row[]> = { budgets: [], bills: [], aboutMe: [], investments: [], investmentHoldings: [], investmentValues: [] };
  const coverage: ExportCoverage[] = [];
  const warnings: string[] = [];
  const accountRules: { revision: number; rules: (AccountRule & { importProvenance: { namespace: string; sourceId: string } })[]; bindings: unknown[] } = { revision: 0, rules: [], bindings: [] };
  function note(id: string, label: string, value: unknown) {
    const body = `${label}\n${typeof value === "string" ? value : JSON.stringify(value)}`;
    // Notebook is limited to 300 characters per note. Split deterministically without truncation.
    const characters = Array.from(body);
    for (let offset = 0, part = 0; offset < characters.length; offset += 300, part++) {
      const sourceId = `${id}:${part}`;
      tables.aboutMe.push({ id: uuid(archive.manifest.namespace, sourceId), importProvenance: { namespace: archive.manifest.namespace, sourceId }, note: characters.slice(offset, offset + 300).join(""), account: null, created_at: at });
    }
  }
  let unsupportedBudgets = 0;
  const plans = object(planning.plans) ? planning.plans : {};
  for (const [month, raw] of Object.entries(plans)) {
    if (!object(raw)) continue;
    note(`plan:${month}`, `Money Tracker plan ${month}`, raw);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !object(raw.categoryLimits)) continue;
    // Explicit category limits have identical month/category/currency semantics.
    // Overall limits, income intentions and repeat behavior have no Alfred equivalent.
    for (const [category, amount] of Object.entries(raw.categoryLimits)) {
      if (!text(category, 40) || !minor(amount, 999_999_999)) { unsupportedBudgets++; continue; }
      tables.budgets.push({ budget_id: `money-plan:${month}:${category}`, period: month, category, amount: money(amount), currency: "GHS", created_at: at, updated_at: at });
    }
  }
  if (Object.keys(plans).length) coverage.push({ dataset: "moneyTracker.native.planning.plans", status: "supported", count: Object.keys(plans).length, reason: "Explicit monthly category limits populate Alfred budgets. Exact complete plans are also restored as Notebook notes. Overall limits, income intentions and automatic repeat behavior remain source-specific evidence, not invented Alfred budgets or savings progress." });
  if (unsupportedBudgets) coverage.push({ dataset: "moneyTracker.native.planning.unrepresentableCategoryLimits", status: "preserved", count: unsupportedBudgets, reason: "Category limits outside Alfred's category or amount limits remain in complete plan notes and the source archive." });

  let unrepresentableBills = 0;
  for (const raw of bills) {
    if (!object(raw)) continue;
    if (!text(raw.id, 200) || !text(raw.name, 80) || !day(raw.nextDate) || !["once", "weekly", "monthly", "yearly"].includes(String(raw.cadence)) || (raw.amount !== null && (!minor(raw.amount) || raw.amount === 0))) {
      unrepresentableBills++; note(`bill:${String(raw.id)}`, "Money Tracker bill requiring review", raw); continue;
    }
    const sourceId = `bill:${raw.id}`;
    tables.bills.push({ id: uuid(archive.manifest.namespace, sourceId), importProvenance: { namespace: archive.manifest.namespace, sourceId }, name: raw.name, next_date: raw.nextDate, amount: raw.amount === null ? null : money(raw.amount as number), currency: "GHS", cadence: raw.cadence, active: raw.active !== false, reminded_for: null, created_at: instant(raw.confirmedAt, at), updated_at: instant(raw.confirmedAt, at) });
  }
  if (bills.length) coverage.push({ dataset: "moneyTracker.native.bills", status: "supported", count: tables.bills.length, reason: "Confirmed bills populate the existing Bills feature. Imported bills start paused until explicitly resumed; notification schedules and delivery state are not imported." });
  if (unrepresentableBills) coverage.push({ dataset: "moneyTracker.native.bills.unrepresentable", status: "preserved", count: unrepresentableBills, reason: "Bills outside Alfred's constraints, including zero-price bills, remain as complete Notebook notes and archive evidence." });

  const overrides = object(planning.overrides) ? planning.overrides : {};
  let noteCount = 0;
  for (const [id, raw] of Object.entries(overrides)) {
    if (!object(raw)) continue;
    const value = Object.fromEntries(["note", "purpose"].filter((key) => typeof raw[key] === "string" && raw[key]).map((key) => [key, raw[key]]));
    if (Object.keys(value).length) { note(`payment-note:${id}`, `Money Tracker payment ${id}`, value); noteCount++; }
  }
  if (noteCount) coverage.push({ dataset: "moneyTracker.native.planning.paymentNotes", status: "supported", count: noteCount, reason: "Payment notes and purposes populate Notebook with their exact source reference. Accounting classifications already travel with the common movements." });
  const rules = Array.isArray(planning.rules) ? planning.rules : [];
  for (let index = 0; index < rules.length; index++) note(`rule:${object(rules[index]) ? String(rules[index].id) : index}`, "Money Tracker categorization rule", rules[index]);
  const sourceAccounts = object(native.snapshot) && Array.isArray(native.snapshot.accounts) ? native.snapshot.accounts.filter(object) : [];
  const commonAccounts = Array.isArray(archive.datasets.accounts) ? archive.datasets.accounts.filter(object) : [];
  let pendingRules = 0;
  for (let index = 0; index < rules.length; index++) {
    const raw = rules[index];
    if (!object(raw) || !text(raw.id, 200) || !text(raw.account, 256) || !text(raw.description, 2000) || !text(raw.category, 120) || ![undefined, "in", "out"].includes(raw.direction as string | undefined) || typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))) { pendingRules++; continue; }
    const accounts = sourceAccounts.filter((account) => typeof account.account === "string" && normalizeRuleText(account.account) === normalizeRuleText(raw.account as string));
    const candidates = accounts.flatMap((account) => commonAccounts.filter((common) => common.id === account.account));
    if (candidates.length !== 1 || index > 200) { pendingRules++; continue; }
    const sourceId = `rule:${raw.id}`, createdAt = new Date(raw.createdAt).toISOString();
    accountRules.rules.push({ id: uuid(archive.manifest.namespace, sourceId), importProvenance: { namespace: archive.manifest.namespace, sourceId }, accountId: String(candidates[0].id), matchMode: "exact", merchantExact: normalizeRuleText(raw.description as string), direction: raw.direction === "in" ? "in" : "out", category: raw.category as string, active: raw.active !== false, priority: 1000 - index, effectiveFrom: createdAt, createdAt, revision: 0 });
  }
  if (accountRules.rules.length) coverage.push({ dataset: "moneyTracker.native.planning.rules", status: "supported", count: accountRules.rules.length, reason: "Rules populate the same durable account-specific store used by Alfred and its bot. Exact normalized merchant text, stable account scope, direction, source start date, source ordering and manual overrides are preserved. No rule becomes all-account activity or a provider-label-only match." });
  if (pendingRules) {
    coverage.push({ dataset: "moneyTracker.native.planning.rules.awaitingAccountMapping", status: "preserved", count: pendingRules, reason: "These rules require a unique supported account mapping or valid source scope. Full rule conditions and relationships remain in Awaiting support, Notebook and the archive; they are not activated ambiguously." });
    warnings.push(`${pendingRules} account-specific rule(s) remain Awaiting support until their account/scope mapping is reviewed.`);
  }
  if (accountRules.rules.length) warnings.push("Imported account rules apply when a movement has its stable account assigned. Future SMS account recognition requires an explicit provider/account-suffix/currency binding; import does not guess provider-wide ownership.");
  if (Array.isArray(planning.thirdPartyGroups) && planning.thirdPartyGroups.length) coverage.push({ dataset: "moneyTracker.native.planning.thirdPartyGroups", status: "preserved", count: planning.thirdPartyGroups.length, reason: "Alfred has no equivalent third-party allocation feature. Groups and audit remain lossless evidence and never become personal spending or invented allocations." });
  if (object(planning.preferences) || object(native.bills)) coverage.push({ dataset: "moneyTracker.native.notificationPreferences", status: "preserved", reason: "Money Tracker payment prompts, weekly summaries and reminder opt-ins have no identical Alfred schedule. They remain evidence and never enable collection or delivery." });
  const portfolios = object(portfolioSource) && Array.isArray(portfolioSource.portfolios) ? portfolioSource.portfolios : [];
  let unsupportedPortfolios = 0;
  let unknownPositions = 0;
  for (const raw of portfolios) {
    if (!object(raw)) continue;
    // The complete snapshot includes allocation weights, unreconciled differences and trade evidence.
    // Preserve all of it in Notebook + archive, even when only some facts have a native equivalent.
    note(`portfolio-evidence:${String(raw.id)}`, "Money Tracker portfolio evidence", raw);
    if (!text(raw.id, 200) || !text(raw.name, 80) || !["GHS", "USD"].includes(String(raw.currency))) { unsupportedPortfolios++; continue; }
    const sourceId = `portfolio:${raw.id}`, investmentId = uuid(archive.manifest.namespace, sourceId);
    const origin = { namespace: archive.manifest.namespace, sourceId };
    const market = typeof raw.market === "string" ? raw.market.toLowerCase() : "";
    const kind = market.startsWith("us stocks") ? "us_stocks" : market.startsWith("ghana stocks") || market.startsWith("gse stocks") ? "gse_stocks" : "other";
    const knownBasis = minor(raw.investedBeforeMinor) ? raw.investedBeforeMinor : null;
    const provider = typeof raw.provider === "string" ? raw.provider : object(raw.provider) && typeof raw.provider.name === "string" ? raw.provider.name : "";
    tables.investments.push({ id: investmentId, importProvenance: origin, name: raw.name, kind, provider: provider.slice(0, 80), currency: raw.currency, invested_before: knownBasis === null ? "0.00" : money(knownBasis), import_cost_basis_unknown: knownBasis === null, principal: null, rate: null, started_on: null, matures_on: null, reminded_at: null, payee_key: null, status: "active", created_at: at, updated_at: at });
    const asOfDay = day(raw.marketAsOf) ? raw.marketAsOf : day(raw.receivedOn) ? raw.receivedOn : null;
    const asOf = asOfDay ? `${asOfDay}T00:00:00.000Z` : typeof raw.marketAsOf === "string" && Number.isFinite(Date.parse(raw.marketAsOf)) ? instant(raw.marketAsOf, at) : null;
    if (minor(raw.reportedValue) && asOf) tables.investmentValues.push({ id: uuid(archive.manifest.namespace, `${sourceId}:reported-value`), importProvenance: { namespace: archive.manifest.namespace, sourceId: `${sourceId}:reported-value` }, investment_id: investmentId, value: money(raw.reportedValue), as_of: asOf, source: "reported", created_at: at });
    else coverage.push({ dataset: `moneyTracker.portfolios.${raw.id}.undatedValue`, status: "preserved", reason: "The source value has no valid stated date. It remains in exact notes and evidence rather than acquiring an invented as-of date." });
    const holdings = Array.isArray(raw.holdings) ? raw.holdings : [];
    const symbols = new Set<string>();
    for (let index = 0; index < holdings.length; index++) {
      const holding = holdings[index];
      const quantityText = object(holding) && (typeof holding.quantity === "number" || typeof holding.quantity === "string") ? String(holding.quantity) : "";
      const quantity = /^\d{1,14}(?:\.\d{1,6})?$/.test(quantityText) ? quantityText : null;
      if (!object(holding) || typeof holding.symbol !== "string" || !/^[A-Z0-9.:-]{1,16}$/.test(holding.symbol) || quantity === null || symbols.has(holding.symbol)) { unknownPositions++; continue; }
      const positionId = `${sourceId}:holding:${holding.symbol}`; symbols.add(holding.symbol);
      tables.investmentHoldings.push({ id: uuid(archive.manifest.namespace, positionId), importProvenance: { namespace: archive.manifest.namespace, sourceId: positionId }, investment_id: investmentId, symbol: holding.symbol, quantity, cost: minor(holding.costBasis) ? money(holding.costBasis) : null, updated_at: at });
    }
  }
  if (portfolios.length) coverage.push({ dataset: "moneyTracker.portfolios", status: "supported", count: tables.investments.length, reason: "Named portfolios populate Investments; dated reported values and explicitly known share quantities/costs populate their native records. Missing basis stays unknown, never a fabricated gain. Complete allocation, historical and unreconciled evidence remains in Notebook and the archive." });
  if (unsupportedPortfolios || unknownPositions) coverage.push({ dataset: "moneyTracker.portfolios.unrepresentablePositions", status: "preserved", count: unsupportedPortfolios + unknownPositions, reason: "Unknown quantities, unsupported identities or duplicate symbols are preserved exactly. Allocation percentages and position values never become invented share counts." });
  if (tables.bills.length) warnings.push("Imported Money Tracker bills start paused. Resume them explicitly in Bills when ready.");
  const restoredNative = { schema: 1 as const, tables, accountRules };
  return { namespace: archive.manifest.namespace, native: restoredNative, coverage, warnings };
}
