/**
 * Static analysis parser for Glubean test files.
 *
 * Uses `@glubean/scanner`'s static extractor as the core regex engine,
 * wrapped in a thin adapter that maps `ExportMeta` to `TestMeta` — VSCode's
 * internal type with flat line numbers, step strings, and `each:`/`pick:`
 * ID prefixes for test routing.
 *
 * `extractPickExamples` and `PickMeta` are imported from `@glubean/scanner/static`
 * for CodeLens rendering — ensuring scanner and VSCode share the same logic.
 */

import {
  extractAliasesFromSource,
  extractContractCases,
  extractFromSource,
  isGlubeanFile as _isGlubeanFile,
  type ExportMeta,
} from "@glubean/scanner/static";

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

  // Fallback: old regex-based discovery (contract.http("id", {))
  const contracts = extractContractCases(content);
  if (contracts.length > 0) {
    return contracts.flatMap((c) =>
      c.cases.map((caseItem) => ({
        type: "test" as const,
        id: `${c.contractId}.${caseItem.key}`,
        name: `${c.endpoint} — ${caseItem.key}`,
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
 * The marker tells us where the contract export is. We then extract:
 * - exportName from "export const <name>"
 * - contractId from the first string argument: ("get-me", ...)
 * - endpoint from "endpoint: "..."
 * - per-case metadata from the cases: { ... } block
 */
function extractContractsByMarker(content: string): TestMeta[] {
  const results: TestMeta[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    if (!/\/\/\s*@contract\s*$/.test(lines[i])) continue;

    // Next line should be "export const <name> = ..."
    const nextLine = lines[i + 1];
    if (!nextLine) continue;
    const exportMatch = nextLine.match(/export\s+const\s+(\w+)/);
    if (!exportMatch) continue;
    const exportName = exportMatch[1];
    const exportLineNum = i + 2; // 1-based

    // Find the contract body from this point forward
    const afterExport = content.slice(content.indexOf(nextLine));

    // Extract contract ID from first string argument: ("get-me", ...)
    const idMatch = afterExport.match(/\(\s*["']([^"']+)["']\s*,\s*\{/);
    if (!idMatch) continue;
    const contractId = idMatch[1];

    // Extract endpoint
    const endpointMatch = afterExport.match(/endpoint\s*:\s*["']([^"']+)["']/);
    const endpoint = endpointMatch ? endpointMatch[1] : contractId;

    // Find cases: { ... } block
    const casesStart = afterExport.indexOf("cases:");
    if (casesStart === -1) continue;

    const afterCases = afterExport.slice(casesStart);
    const braceIdx = afterCases.indexOf("{");
    if (braceIdx === -1) continue;

    // Walk the cases block to find top-level case keys. Two property
    // shapes occur in cookbook v10:
    //   - INLINE:    `key: { description: ..., expect: ... },`
    //   - SHORTHAND: `key,`  (key references a `defineHttpCase()` value
    //     bound elsewhere — the canonical attachment-model v10 pattern).
    //
    // Both must produce a TestItem. Pre-fix only inline was supported
    // (key captured only when a `{` opened at depth==1); shorthand-only
    // contract files had ZERO TestItems in the Test Explorer / no gutter ▶.
    // Mirror logic of `contractLensCore.ts:computeContractLensesByMarker`
    // (fixed 2026-04-27); diverged because parser.ts and contractLensCore.ts
    // are independent code paths feeding two separate VSCode surfaces.
    const casesContent = afterCases.slice(braceIdx);
    const topLevelKeys: { key: string; offset: number; shorthand: boolean }[] = [];
    let depth = 0;
    let segmentStart = 1; // start of current top-level segment, just past the outer `{`
    let segmentSawInlineBrace = false;

    for (let j = 0; j < casesContent.length; j++) {
      const ch = casesContent[j];
      if (ch === "{") {
        if (depth === 1) {
          // Inline case body — capture key by looking BACKWARDS from this `{`.
          const before = casesContent.slice(0, j).trimEnd();
          const keyMatch = before.match(/["']?(\w+)["']?\s*:\s*$/);
          if (keyMatch) {
            topLevelKeys.push({ key: keyMatch[1], offset: j, shorthand: false });
            segmentSawInlineBrace = true;
          }
        }
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          // Last segment may be a trailing shorthand (no trailing comma).
          if (!segmentSawInlineBrace) {
            const seg = casesContent.slice(segmentStart, j);
            const m = seg.match(/^(\s*)(\w+)\s*$/);
            if (m) {
              topLevelKeys.push({
                key: m[2],
                offset: segmentStart + m[1].length,
                shorthand: true,
              });
            }
          }
          break;
        }
      } else if (ch === "," && depth === 1) {
        // Top-level segment boundary. If the segment didn't open an inline
        // body, treat it as a shorthand identifier.
        if (!segmentSawInlineBrace) {
          const seg = casesContent.slice(segmentStart, j);
          const m = seg.match(/^(\s*)(\w+)\s*$/);
          if (m) {
            topLevelKeys.push({
              key: m[2],
              offset: segmentStart + m[1].length,
              shorthand: true,
            });
          }
        }
        segmentStart = j + 1;
        segmentSawInlineBrace = false;
      }
    }

    for (const { key, offset, shorthand } of topLevelKeys) {
      // Calculate absolute position for line number
      const absolutePos = content.indexOf(nextLine) + casesStart + braceIdx + offset;
      const caseLine = content.substring(0, absolutePos).split("\n").length;

      if (!shorthand) {
        // Inline case: extract metadata from its body for completeness.
        // Today TestItem only carries `id` / `name` / `line` / `exportName`
        // — the metadata fields are not surfaced. The extraction stays
        // (matches pre-fix behavior) so a future TestItem refresh can
        // pick them up without re-parsing.
        let caseDepth = 0;
        let caseEnd = offset;
        for (let j = offset; j < casesContent.length; j++) {
          if (casesContent[j] === "{") caseDepth++;
          else if (casesContent[j] === "}") {
            caseDepth--;
            if (caseDepth === 0) { caseEnd = j; break; }
          }
        }
        const caseBody = casesContent.slice(offset, caseEnd + 1);
        // Currently unused by TestMeta — kept for parity with prior behavior
        // and as a place to wire into TestItem metadata when we surface
        // deferred/requires hints in Test Explorer.
        void caseBody.match(/description\s*:\s*["']([^"']+)["']/);
        void caseBody.match(/deferred\s*:\s*["']([^"']+)["']/);
        void caseBody.match(/requires\s*:\s*["'](headless|browser|out-of-band)["']/);
        void caseBody.match(/defaultRun\s*:\s*["'](always|opt-in)["']/);
      }
      // Shorthand cases: no inline body to scan. Metadata lives inside
      // the referenced `defineHttpCase()` call. CodeLens treats this
      // the same way (plain `▶ run` lens, no metadata-aware variants);
      // matching that here keeps the two surfaces consistent.

      results.push({
        type: "test",
        id: `${contractId}.${key}`,
        name: `${endpoint} — ${key}`,
        exportName,
        line: caseLine,
      });
    }
  }

  return results;
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
  const results: TestMeta[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    if (!/\/\/\s*@flow\s*$/.test(lines[i])) continue;

    const nextLine = lines[i + 1];
    if (!nextLine) continue;
    const exportMatch = nextLine.match(/export\s+const\s+(\w+)/);
    if (!exportMatch) continue;
    const exportName = exportMatch[1];
    const exportLine = i + 2; // 1-based

    const afterExport = content.slice(content.indexOf(nextLine));
    const flowIdMatch = afterExport.match(/\.flow\s*\(\s*["']([^"']+)["']/);
    if (!flowIdMatch) continue;
    const flowId = flowIdMatch[1];

    results.push({
      type: "test",
      id: flowId,
      name: flowId,
      exportName,
      line: exportLine,
    });
  }

  return results;
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
export interface BootstrapMarker {
  /** The exporting variable name in the .bootstrap.ts file (e.g. `meAuthorizedOverlay`). */
  exportName: string;
  /** 1-based line number where `export const X = contract.bootstrap(...)` starts. */
  exportLine: number;
  /** Local identifier referenced via `IDENT.case("KEY")` (e.g. `getMe`).
   *  May be an alias from `import { getMe as me } from "..."`. */
  targetIdent: string;
  /** The case key (e.g. `authorized`) referenced via `.case("KEY")`. */
  caseKey: string;
}

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
  const lines = content.split("\n");
  const markers: BootstrapMarker[] = [];

  // Pre-compute all `export const NAME` line indices so we can bound
  // each export body at the NEXT one without an O(n²) re-scan.
  const exportLines: { line: number; name: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*export\s+const\s+(\w+)\s*=/);
    if (m) exportLines.push({ line: i, name: m[1] });
  }

  for (let idx = 0; idx < exportLines.length; idx++) {
    const { line: i, name: exportName } = exportLines[idx];
    const next = exportLines[idx + 1];
    const endLine = next ? next.line : lines.length;

    // Slice the export body from `export const` line (inclusive) to the
    // line BEFORE the next `export const`.
    const body = lines.slice(i, endLine).join("\n");

    const bsMatch = body.match(
      /\bcontract\s*\.\s*bootstrap\s*\(\s*(\w+)\s*\.\s*case\s*\(\s*["']([^"']+)["']\s*\)/,
    );
    if (!bsMatch) continue;

    markers.push({
      exportName,
      exportLine: i + 1, // 1-based to match other detectors
      targetIdent: bsMatch[1],
      caseKey: bsMatch[2],
    });
  }

  return markers;
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
  const importBlocks = content.matchAll(
    /import\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s+["']([^"']+)["']/g,
  );
  for (const block of importBlocks) {
    const names = block[1].split(",").map((s) => s.trim());
    for (const name of names) {
      // `original as alias` form — split into both sides.
      const aliasMatch = name.match(/^(\w+)\s+as\s+(\w+)$/);
      if (aliasMatch) {
        const [, original, alias] = aliasMatch;
        if (alias === localIdent) {
          return { path: block[2], originalName: original };
        }
      } else {
        const cleaned = name.replace(/\s+/g, "");
        if (cleaned === localIdent) {
          return { path: block[2], originalName: cleaned };
        }
      }
    }
  }
  return undefined;
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
  // Match `export const NAME = X("id", {` where X may be a chain like
  // `dummyApi("id", {)` — we only need the first string literal arg.
  const escaped = exportName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    String.raw`export\s+const\s+${escaped}\s*=\s*[\w.]+\s*\(\s*["']([^"']+)["']\s*,`,
  );
  const m = content.match(re);
  return m?.[1];
}
