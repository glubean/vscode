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
  // extractFromSource found no test() calls. Try contract path.

  // First: try // @contract marker-based discovery (supports .with() syntax)
  const markerTests = extractContractsByMarker(content);
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

    // Extract top-level keys by tracking brace depth
    const casesContent = afterCases.slice(braceIdx);
    const topLevelKeys: { key: string; offset: number }[] = [];
    let depth = 0;

    for (let j = 0; j < casesContent.length; j++) {
      if (casesContent[j] === "{") {
        if (depth === 1) {
          const before = casesContent.slice(0, j).trimEnd();
          const keyMatch = before.match(/["']?(\w+)["']?\s*:\s*$/);
          if (keyMatch) {
            topLevelKeys.push({ key: keyMatch[1], offset: j });
          }
        }
        depth++;
      } else if (casesContent[j] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }

    for (const { key, offset } of topLevelKeys) {
      // Calculate absolute position for line number
      const absolutePos = content.indexOf(nextLine) + casesStart + braceIdx + offset;
      const caseLine = content.substring(0, absolutePos).split("\n").length;

      // Extract case body
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

      // Extract case-level fields
      const descMatch = caseBody.match(/description\s*:\s*["']([^"']+)["']/);
      const deferredMatch = caseBody.match(/deferred\s*:\s*["']([^"']+)["']/);
      const requiresMatch = caseBody.match(/requires\s*:\s*["'](headless|browser|out-of-band)["']/);
      const defaultRunMatch = caseBody.match(/defaultRun\s*:\s*["'](always|opt-in)["']/);

      const variant = deferredMatch ? "each" : undefined; // not actually each, but need deferred info

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

// extractPickExamples and PickMeta are now imported from @glubean/scanner/static
// See codeLensProvider.ts for usage.
