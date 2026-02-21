/**
 * Static analysis parser for Glubean test files.
 *
 * Uses `@glubean/scanner`'s static extractor as the core regex engine,
 * wrapped in a thin adapter that maps `ExportMeta` to `TestMeta` — VSCode's
 * internal type with flat line numbers, step strings, and `each:`/`pick:`
 * ID prefixes for test routing.
 *
 * `extractPickExamples` remains VSCode-local — it serves CodeLens rendering
 * and has no equivalent in the scanner.
 */

import {
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

// Re-export so existing consumers (testController, codeLensProvider, etc.)
// don't need to change their imports.
export const isGlubeanFile = _isGlubeanFile;

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
 * @returns Array of discovered test metadata, or empty array if not a Glubean file
 */
export function extractTests(content: string): TestMeta[] {
  if (!isGlubeanFile(content)) {
    return [];
  }

  const all = extractFromSource(content).map(toTestMeta);

  // Deduplicate by id — keeps first occurrence when multiple exports share
  // the same test id (e.g. re-exports or copy-paste errors).
  const seen = new Set<string>();
  return all.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

// ---------------------------------------------------------------------------
// test.pick example extraction (for CodeLens)
// ---------------------------------------------------------------------------

/**
 * Get 1-based line number for a character position in content.
 * Kept locally because extractPickExamples needs it.
 */
function getLineNumber(content: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos && i < content.length; i++) {
    if (content[i] === "\n") {
      line++;
    }
  }
  return line;
}

/** Metadata for a discovered test.pick() call, used by CodeLens. */
export interface PickMeta {
  /** The test ID template (e.g. "create-user-$_pick") */
  testId: string;
  /** Source location (1-based line number) */
  line: number;
  /** Export name of the variable */
  exportName: string;
  /**
   * Statically resolved example keys, or null if keys could not be determined.
   * null means CodeLens should show a format hint instead of run buttons.
   */
  keys: string[] | null;
  /**
   * How the data was sourced — helps CodeLens resolve keys at render time.
   * - "inline": keys extracted directly from object literal in source
   * - "json-import": keys come from an imported JSON file (path provided)
   */
  dataSource?: { type: "inline" } | { type: "json-import"; path: string };
}

/**
 * Extract test.pick() metadata from a Glubean test file for CodeLens rendering.
 *
 * Handles two data source patterns:
 * 1. Inline object literal: `test.pick({ "key1": ..., "key2": ... })`
 * 2. JSON import variable: `import X from "./data.json"` then `test.pick(X)`
 *
 * For other patterns (dynamic vars, fromYaml, etc.), returns keys: null
 * so CodeLens can show a format hint.
 *
 * @param content - TypeScript source code
 * @returns Array of PickMeta, or empty if no test.pick calls found
 */
export function extractPickExamples(content: string): PickMeta[] {
  if (!isGlubeanFile(content)) {
    return [];
  }

  const results: PickMeta[] = [];

  // Build a map of JSON imports: variable name → file path
  // Matches: import X from "./path.json" with { type: "json" }
  // Also matches: import X from "./path.json" assert { type: "json" }
  // Also matches: import X from "./path.json" (bare, Deno supports it)
  const jsonImports = new Map<string, string>();
  const importPattern = /import\s+(\w+)\s+from\s+["']([^"']+\.json)["']/g;
  let importMatch: RegExpExecArray | null;
  while ((importMatch = importPattern.exec(content)) !== null) {
    jsonImports.set(importMatch[1], importMatch[2]);
  }

  // ── Pattern 1: Inline object literal ────────────────────────────────────
  // Matches: test.pick({ "key1": ..., "key2": ... })("id-$_pick", ...)
  // We look for test.pick(\s*{ and try to extract top-level string keys.
  const inlinePickPattern =
    /export\s+const\s+(\w+)\s*=\s*test\.pick\s*\(\s*\{([\s\S]*?)\}\s*\)\s*\(\s*["']([^"']+)["']/g;

  let match: RegExpExecArray | null;
  while ((match = inlinePickPattern.exec(content)) !== null) {
    const exportName = match[1];
    const objectBody = match[2];
    const testId = match[3];
    const line = getLineNumber(content, match.index);

    // Extract only top-level keys from the object body.
    // We track brace depth to skip nested object keys like { q: ..., body: { name: ... } }.
    // Only keys at depth 0 (the outer test.pick object) are example names.
    const keys: string[] = [];
    let depth = 0;
    // Scan character by character, extracting keys only at depth 0
    for (let i = 0; i < objectBody.length; i++) {
      const ch = objectBody[i];
      if (ch === "{" || ch === "[") {
        depth++;
      } else if (ch === "}" || ch === "]") {
        depth--;
      } else if (depth === 0) {
        // Try to match a key at this position: "key": or 'key': or key:
        const remaining = objectBody.slice(i);
        const keyMatch = remaining.match(
          /^(?:["']([^"']+)["']|([a-zA-Z_]\w*))\s*:/,
        );
        if (keyMatch) {
          keys.push(keyMatch[1] || keyMatch[2]);
          // Skip past this key match to avoid re-matching
          i += keyMatch[0].length - 1;
        }
      }
    }

    results.push({
      testId,
      line,
      exportName,
      keys: keys.length > 0 ? keys : null,
      dataSource: keys.length > 0 ? { type: "inline" } : undefined,
    });
  }

  // ── Pattern 2: Variable reference (JSON import or other) ────────────────
  // Matches: test.pick(variableName)("id-$_pick", ...)
  // Must NOT match the inline pattern (which has { after test.pick( )
  const varPickPattern =
    /export\s+const\s+(\w+)\s*=\s*test\.pick\s*\(\s*(\w+)\s*\)\s*\(\s*["']([^"']+)["']/g;

  while ((match = varPickPattern.exec(content)) !== null) {
    const exportName = match[1];
    const varName = match[2];
    const testId = match[3];
    const line = getLineNumber(content, match.index);

    // Check if the variable is a JSON import
    const jsonPath = jsonImports.get(varName);
    if (jsonPath) {
      // Keys will be resolved at CodeLens render time by reading the file
      results.push({
        testId,
        line,
        exportName,
        keys: null, // resolved lazily by CodeLens provider via fs
        dataSource: { type: "json-import", path: jsonPath },
      });
    } else {
      // Unknown variable — cannot resolve statically
      results.push({
        testId,
        line,
        exportName,
        keys: null,
        dataSource: undefined,
      });
    }
  }

  return results;
}
