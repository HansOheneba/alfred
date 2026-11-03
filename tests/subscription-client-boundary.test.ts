import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** Follow emitted runtime edges; type-only references to server record types are erased. */
function clientRuntimeGraph(entry: string) {
  const visited = new Set<string>(), externals = new Set<string>();
  function walk(file: string) {
    if (visited.has(file)) return;
    visited.add(file);
    const emitted = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const source = ts.createSourceFile(file, emitted, ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const name = statement.moduleSpecifier.text;
      if (!name.startsWith("@/") && !name.startsWith(".")) { externals.add(name); continue; }
      const base = name.startsWith("@/") ? path.resolve(name.slice(2)) : path.resolve(path.dirname(file), name);
      const found = [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, path.join(base, "index.ts")].find((candidate) => existsSync(candidate));
      if (!found) throw new Error(`Unresolved local client dependency: ${name}`);
      walk(found);
    }
  }
  walk(path.resolve(entry));
  return { files: [...visited].map((file) => path.relative(process.cwd(), file)), externals: [...externals] };
}

describe("subscription browser boundary", () => {
  it("keeps the full suggestion calculation graph free of database/server modules", () => {
    const graph = clientRuntimeGraph("app/accounts/subscriptions-data.ts");
    expect(graph.files).toContain("lib/finance/bill-renewals.ts");
    expect(graph.files).toContain("lib/finance/bill-schedule.ts");
    expect(graph.files.filter((file) => /lib\/supabase\/|lib\/env\.|persisted-store|lib\/finance\/bills\.ts$/.test(file))).toEqual([]);
    expect(graph.externals.filter((name) => name === "pg" || name.startsWith("node:") || ["fs", "net", "tls", "dns", "crypto"].includes(name))).toEqual([]);
  });
});
