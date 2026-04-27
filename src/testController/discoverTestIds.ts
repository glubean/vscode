/**
 * Decide the harness's run scope from the caller's intent.
 *
 * Synchronous and pure — no dynamic import, no filesystem reads, no
 * cwd dependency. Per-row test ids of `test.each` / `test.pick` exports
 * are runtime data; only the harness's environment (correct cwd, .env
 * loaded, plugins registered) can produce them. This function NEVER
 * tries to enumerate them in the VSCode parent process.
 *
 * Two scope sentinels:
 * - `["*"]` (no exportName): harness wildcard mode — runs every test
 *   in the file via `resolveModuleTests`.
 * - `[""]` (with exportName): harness exportName-only mode (runner
 *   ≥0.2.6) — enumerates and runs every test belonging to that export,
 *   including each per-row case for data-driven exports. Critical:
 *   returning `["*"]` here would ignore the exportName scope and widen
 *   to the whole file.
 *
 * History: prior versions of this function did `await import(fileUrl)`
 * + `runner.resolveModuleTests(mod)` to enumerate ids parent-side. That
 * path silently failed when test files had top-level cwd-dependent code
 * (e.g. `await fromCsv("data/x.csv")`) because VSCode's `process.cwd()`
 * is its launch dir, not the project root. The discovery silently
 * returned the same `[""]` sentinel via try/catch, but downstream
 * harness rejected the empty testId. See:
 * `internal/30-execution/2026-04-27-data-driven-discovery-rebuild/`.
 *
 * The harness is the single source of truth for data-driven enumeration.
 * Parent only decides scope.
 *
 * Lives in its own module (not in `executor.ts`) so unit tests can import
 * it without pulling in `vscode` (which `executor.ts` depends on).
 */
export function discoverTestIds(exportName?: string): string[] {
  return exportName ? [""] : ["*"];
}
