/**
 * Static analysis parser for Glubean test files.
 *
 * Uses `@glubean/scanner`'s static extractor for test()/pick()/each() and
 * a TypeScript AST pass for contract/flow/bootstrap declarations,
 * wrapped in a thin adapter that maps `ExportMeta` to `TestMeta` — VSCode's
 * internal type with flat line numbers, step strings, and `each:`/`pick:`
 * ID prefixes for test routing.
 *
 * `extractPickExamples` and `PickMeta` are imported from `@glubean/scanner/static`
 * for CodeLens rendering — ensuring scanner and VSCode share the same logic.
 */

import {
  extractAliasesFromSource,
  extractFromSource,
  isGlubeanFile as _isGlubeanFile,
  type ExportMeta,
} from "@glubean/scanner/static";
import {
  extractBootstrapMarkers as extractBootstrapMarkersAst,
  extractContracts as extractContractsAst,
  extractMarkedContracts,
  extractMarkedFlows,
  findContractIdInTarget as findContractIdInTargetAst,
  findImportPath as findImportPathAst,
  type BootstrapMarker,
} from "./contractAst";

/** Metadata for a discovered test */
export interface TestMeta {
  /** Test type */
  type: "test";
  /** Unique test ID */
  id: string;
  /** Human-readable name */
  name?: string;
  /** Tags for filtering */
  tags?: string[];
  /** JavaScript export name (e.g., "myTest") */
  exportName: string;
  /** Source location (1-based line number) */
  line: number;
  /** Builder steps (for multi-step tests) */
  steps?: string[];
}

const DIRECT_SDK_IMPORT_PATTERN =
  /from\s+["'](?:@glubean\/sdk(?:\/[^"']*)?|jsr:@glubean\/sdk(?:@[^"']+)?)["']/;

// VSCode should be conservative here: only direct SDK imports count by
// default. Alias-based detection remains opt-in via customFns.
export function isGlubeanFile(content: string, customFns?: string[]): boolean {
  if (DIRECT_SDK_IMPORT_PATTERN.test(content)) {
    return true;
  }
  if (!customFns || customFns.length === 0) {
    return false;
  }
  return _isGlubeanFile(content, customFns);
}

export { extractAliasesFromSource };

// ---------------------------------------------------------------------------
// ExportMeta → TestMeta adapter
// ---------------------------------------------------------------------------

/**
 * Map a scanner `ExportMeta` to a VSCode `TestMeta`.
 *
 * Applies VSCode-specific conventions:
 * - Prefixes `each`/`pick` IDs (e.g. `"each:get-user-$id"`) for routing
 * - Appends `(data-driven)` / `(pick)` to name for test explorer display
 * - Defaults `name` to `id` when not explicitly set
 * - Flattens step objects to plain strings
 * - Maps `location.line` to flat `line` number
 */
function toTestMeta(e: ExportMeta): TestMeta {
  let name = e.name ?? e.id;
  if (e.variant === "each") {
    name = `${e.name ?? e.id} (data-driven)`;
  } else if (e.variant === "pick") {
    name = `${e.name ?? e.id} (pick)`;
  }

  const meta: TestMeta = {
    type: "test",
    id: e.variant ? `${e.variant}:${e.id}` : e.id,
    name,
    exportName: e.exportName,
    line: e.location?.line ?? 0,
  };

  if (e.tags && e.tags.length > 0) meta.tags = e.tags;
  if (e.steps && e.steps.length > 0) meta.steps = e.steps.map((s) => s.name);

  return meta;
}

// ---------------------------------------------------------------------------
// Main extraction
// ---------------------------------------------------------------------------

/**
 * Extract all test metadata from a Glubean test file's source content.
 *
 * This is a pure function — no file system or runtime needed.
 *
 * @param content - TypeScript source code
 * @param customFns - Additional function names discovered via alias scanning.
 *                    Passed through to `extractFromSource`.
 * @returns Array of discovered test metadata, or empty array if no tests found
 */
export function extractTests(content: string, customFns?: string[]): TestMeta[] {
  if (!isGlubeanFile(content, customFns)) {
    return [];
  }

  // Try test() path first
  const all = extractFromSource(content, customFns).map(toTestMeta);
  if (all.length > 0) {
    // Deduplicate by id — keeps first occurrence when multiple exports share
    // the same test id (e.g. re-exports or copy-paste errors).
    const seen = new Set<string>();
    return all.filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
  }

  // Fall through: isGlubeanFile passed (file imports @glubean/sdk) but
  // extractFromSource found no test() calls. Try contract / flow paths.

  // Collect contract cases AND flow entries by marker. Files can declare
  // both (e.g. cookbook's flow.contract.ts co-locates contracts + a flow).
  const markerTests = [
    ...extractContractsByMarker(content),
    ...extractFlowsByMarker(content),
  ];
  if (markerTests.length > 0) return markerTests;

  // Fallback: unmarked contract declarations such as `contract.http("id", {...})`.
  const contracts = extractContractsAst(content);
  if (contracts.length > 0) {
    return contracts.flatMap((c) =>
      c.cases.map((caseItem) => ({
        type: "test" as const,
        id: `${c.contractId}.${caseItem.key}`,
        name: `${c.endpoint ?? c.contractId} — ${caseItem.key}`,
        exportName: c.exportName,
        line: caseItem.line,
      })),
    );
  }

  return [];
}

// ---------------------------------------------------------------------------
// // @contract marker-based contract extraction
// ---------------------------------------------------------------------------

/**
 * Extract contract tests from // @contract markers.
 *
 * Pattern:
 *   // @contract
 *   export const getMe = userApi("get-me", {
 *     endpoint: "GET /me",
 *     cases: { ok: { ... }, notFound: { ... } },
 *   });
 *
 * The marker tells us where the contract export is. We then extract via AST:
 * - exportName from "export const <name>"
 * - contractId from the first string argument: ("get-me", ...)
 * - endpoint from "endpoint: "..."
 * - per-case metadata from the cases: { ... } block
 */
function extractContractsByMarker(content: string): TestMeta[] {
  return extractMarkedContracts(content).flatMap((contract) =>
    contract.cases.map((caseItem) => ({
      type: "test" as const,
      id: `${contract.contractId}.${caseItem.key}`,
      name: `${contract.endpoint ?? contract.contractId} — ${caseItem.key}`,
      exportName: contract.exportName,
      line: caseItem.line,
    })),
  );
}

// ---------------------------------------------------------------------------
// // @flow marker-based flow extraction
// ---------------------------------------------------------------------------

/**
 * Extract flow tests from `// @flow` markers.
 *
 * Pattern:
 *   // @flow
 *   export const signupFlow = contract
 *     .flow("signup-flow")
 *     .meta({ description: "..." })
 *     .step(...)
 *     .compute(...)
 *     .step(...);
 *
 * A flow is a single executable unit — one TestMeta per flow, using the
 * flow id as the test id. Skip-at-declaration via `.meta({ skip: "..." })`
 * is detected but still emitted as a TestMeta so the Test Explorer shows
 * the entry (runtime ctx.skip() renders the reason at run time).
 *
 * Supported authoring form:
 *   - literal string arg to `.flow(...)`
 *   - optional `.meta({ ... })` somewhere in the chain
 * Dynamic ids (computed at runtime) are not detected by this static pass.
 */
function extractFlowsByMarker(content: string): TestMeta[] {
  return extractMarkedFlows(content).map((flow) => ({
    type: "test" as const,
    id: flow.flowId,
    name: flow.flowId,
    exportName: flow.exportName,
    line: flow.line,
  }));
}

// extractPickExamples and PickMeta are now imported from @glubean/scanner/static
// See codeLensProvider.ts for usage.

// ---------------------------------------------------------------------------
// Bootstrap overlay marker extraction (v10 attachment-model §7.4)
// ---------------------------------------------------------------------------

/**
 * Raw marker for an overlay export found in a `*.bootstrap.ts` file.
 *
 * Pure marker only — no cross-file resolution. The caller (testController's
 * `parseFile`) does the readFile dance to resolve `targetIdent` to the
 * real contract file + contract id, since that requires filesystem access
 * that doesn't belong in a pure parser.
 *
 * Mirrors the contract / flow detector shape — one marker per overlay
 * export, line-attributed for TestItem range placement.
 */
export type { BootstrapMarker };

/**
 * Find every `contract.bootstrap(IDENT.case("KEY"), ...)` export in the
 * file. Tolerates both inline and multi-line forms; the `.case("KEY")`
 * argument may be on a later line than the `export const`.
 *
 * Search window per export is bounded by the NEXT `export const` (or
 * EOF) so a `contract.bootstrap()` declared in a later export can't be
 * misattributed to an earlier non-overlay export.
 *
 * Pure: no fs, no path resolution. Used by `testController.parseFile`
 * which then performs cross-file resolution to register shadow TestItems
 * pointing at the target contract case.
 *
 * Shape mirrors `contractLensCore.ts:findBootstrapMatches` — both feed
 * different VSCode surfaces (Test Explorer / gutter vs CodeLens text).
 * Lift to a shared module if a third caller appears.
 */
export function extractBootstrapMarkers(content: string): BootstrapMarker[] {
  return extractBootstrapMarkersAst(content);
}

/**
 * Find the import statement that brings `localIdent` into scope.
 *
 * Returns `{ path, originalName }` — the import path as written, plus
 * the ORIGINAL exported name on the other side of the `as` (or the
 * same name when no alias). Callers need `originalName` to look up
 * the symbol in the target file (the local alias is meaningless there).
 *
 * Tolerates multi-line `import { ... }` blocks. Does NOT follow
 * re-exports or barrel files.
 *
 * Mirrors `contractLensCore.ts:findImportPath`.
 */
export function findImportPath(
  content: string,
  localIdent: string,
): { path: string; originalName: string } | undefined {
  return findImportPathAst(content, localIdent);
}

/**
 * Find the contractId on a `// @contract`-marked export by name.
 * Returns the literal `"id"` from `<factory>("id", { ... })` or undefined.
 *
 * Mirrors `contractLensCore.ts:findContractIdInTarget`.
 */
export function findContractIdInTarget(
  content: string,
  exportName: string,
): string | undefined {
  return findContractIdInTargetAst(content, exportName);
}
