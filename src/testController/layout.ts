/**
 * Pure helpers for Test Explorer layout modes (flat / tree / auto).
 *
 * These functions have no VS Code dependency so they can be unit-tested
 * with node:test directly.
 */

export type LayoutMode = "flat" | "tree" | "auto";
export type EffectiveLayout = "flat" | "tree";

/**
 * Resolve an effective layout ("flat" or "tree") from user setting + file count.
 */
export function resolveLayout(
  mode: LayoutMode,
  fileCount: number,
): EffectiveLayout {
  if (mode === "flat") return "flat";
  if (mode === "tree") return "tree";
  // auto: ≤15 files → flat, >15 → tree
  return fileCount > 15 ? "tree" : "flat";
}

/**
 * Extract the directory segments between a known top-level directory prefix
 * and the file name.
 *
 * Examples:
 *   buildDirSegments("explore/dummyjson/smoke.test.ts", "explore")
 *     → ["dummyjson"]
 *   buildDirSegments("explore/github/smoke/public.test.ts", "explore")
 *     → ["github", "smoke"]
 *   buildDirSegments("tests/smoke.test.ts", "tests")
 *     → []
 *   buildDirSegments("tests/api/users.test.ts", "tests")
 *     → ["api"]
 *
 * @param relPath  Workspace-relative path using forward slashes
 * @param prefix   Top-level directory to strip ("explore" or "tests")
 */
export function buildDirSegments(
  relPath: string,
  prefix: string,
): string[] {
  // Normalise separators
  const normalized = relPath.replace(/\\/g, "/");

  // Strip the prefix (e.g. "explore/" or "tests/")
  const prefixWithSlash = prefix.endsWith("/") ? prefix : prefix + "/";
  const inner = normalized.startsWith(prefixWithSlash)
    ? normalized.slice(prefixWithSlash.length)
    : normalized;

  // Split and drop the last part (the filename)
  const parts = inner.split("/");
  // Remove filename
  parts.pop();
  return parts;
}
