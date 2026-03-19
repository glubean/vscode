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

  const all = extractFromSource(content, customFns).map(toTestMeta);

  // Deduplicate by id — keeps first occurrence when multiple exports share
  // the same test id (e.g. re-exports or copy-paste errors).
  const seen = new Set<string>();
  return all.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

// extractPickExamples and PickMeta are now imported from @glubean/scanner/static
// See codeLensProvider.ts for usage.
