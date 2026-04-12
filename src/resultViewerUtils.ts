/**
 * Pure utility functions for the result viewer.
 *
 * No dependency on the `vscode` module — safe to import in tests.
 */

import * as path from "path";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Failed test ID extraction
// ---------------------------------------------------------------------------

/** Minimal shape of a result file for extracting failed test IDs. */
export interface ResultForRerun {
  tests?: Array<{ testId: string; success: boolean }>;
}

/**
 * Extract testIds of failed tests from a GlubeanResult-shaped object.
 * Returns an empty array when there are no failures or input is invalid.
 */
export function extractFailedTestIds(result: ResultForRerun | null | undefined): string[] {
  if (!result || !Array.isArray(result.tests)) return [];
  return result.tests
    .filter((t) => !t.success)
    .map((t) => t.testId);
}

const TEST_EXTS = [".ts", ".js", ".mjs"] as const;

/**
 * Infer the source test file path from a result file path.
 *
 * Supports two layouts:
 * 1. **Side-file**: `smoke.test.result.json` -> `smoke.test.ts` (same directory)
 * 2. **History**:   `.glubean/results/smoke.test/dj-get/20260318T231054.result.json`
 *                   -> search upward for `smoke.test.ts` in the workspace
 *
 * Returns `undefined` if no matching source file is found on disk.
 */
export function inferSourcePath(resultPath: string): string | undefined {
  const basename = path.basename(resultPath);

  // Case 1: side-file — e.g. smoke.test.result.json or create.contract.result.json
  const sideFileMatch = basename.match(/^(.+\.(?:test|contract))\.result\.json$/);
  if (sideFileMatch) {
    const stem = sideFileMatch[1]; // e.g. "smoke.test"
    const dir = path.dirname(resultPath);
    for (const ext of TEST_EXTS) {
      const candidate = path.join(dir, stem + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  // Case 2: history — .glubean/results/{baseName}/{testId}/{timestamp}.result.json
  // Walk up from the result file to find the .glubean/results/ prefix.
  const segments = resultPath.split(path.sep);
  const resultsIdx = segments.lastIndexOf("results");
  const glubeanIdx = resultsIdx > 0 ? resultsIdx - 1 : -1;

  if (
    glubeanIdx >= 0 &&
    segments[glubeanIdx] === ".glubean" &&
    resultsIdx + 1 < segments.length
  ) {
    const baseName = segments[resultsIdx + 1]; // e.g. "smoke.test"
    // The workspace root is everything before .glubean/
    const workspaceRoot = segments.slice(0, glubeanIdx).join(path.sep) || "/";

    return findSourceFile(workspaceRoot, baseName);
  }

  return undefined;
}

/**
 * Recursively search for a test source file by its base name (e.g. "smoke.test")
 * within a workspace directory. Returns the first match found.
 */
function findSourceFile(
  dir: string,
  baseName: string,
  maxDepth = 5,
): string | undefined {
  if (maxDepth <= 0) return undefined;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  // Check files in this directory first
  for (const ext of TEST_EXTS) {
    const target = baseName + ext;
    if (entries.some((e) => e.isFile() && e.name === target)) {
      return path.join(dir, target);
    }
  }

  // Recurse into subdirectories (skip node_modules, .glubean, hidden dirs)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (
      entry.name === "node_modules" ||
      entry.name === ".glubean" ||
      entry.name.startsWith(".")
    ) continue;
    const found = findSourceFile(
      path.join(dir, entry.name),
      baseName,
      maxDepth - 1,
    );
    if (found) return found;
  }

  return undefined;
}
