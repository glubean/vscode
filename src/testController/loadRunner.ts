/**
 * cwd-aware loader for `@glubean/runner`.
 *
 * Why this exists: VSCode's vendored `@glubean/runner` lives at
 * `vscode/dist/node_modules/@glubean/runner` and bundles its own
 * `@glubean/sdk`. When the harness subprocess (path resolved relative
 * to `harness.js`) imports `@glubean/sdk`, Node's resolution finds the
 * vendored copy. But the user's test code imports `@glubean/sdk` from
 * `<userProject>/node_modules/@glubean/sdk` — a DIFFERENT module
 * instance. After SDK 0.2.1's removal of the `globalThis.__glubeanRuntime`
 * shim, these two instances no longer share state through the implicit
 * globalThis bridge. The harness `setRuntime()` writes to the vendored
 * SDK's closure-scoped module slot; the user SDK's slot stays empty;
 * any access to `configure()` lazy values from inside a test throws
 * "configure() values can only be accessed during test execution".
 *
 * Resolution order (mirrors the existing `isScratchMode` shape that
 * already keys off `node_modules/@glubean/sdk`):
 *
 *   1. Project-local — if `<cwd>/node_modules/@glubean/runner` exists
 *      with a resolvable ESM entry, load THAT runner. Its harness path
 *      resolves to the project's own `harness.js`, the subprocess's
 *      `@glubean/sdk` resolution stays inside the user's `node_modules`,
 *      and `setRuntime()` reaches the same SDK instance the user code
 *      reads from. Single instance, no bridge needed.
 *
 *   2. Vendored fallback — used for scratch mode (no `node_modules/`),
 *      missing-deps recovery, or any failure loading the project-local
 *      copy. Logged so a corrupted local install doesn't silently
 *      regress to vendored.
 *
 * Cache is keyed by cwd; multiple Glubean projects in a multi-root
 * workspace each get their own runner module.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

type RunnerModule = typeof import("@glubean/runner");

let _vendoredRunner: RunnerModule | undefined;
const _projectRunnerCache = new Map<string, RunnerModule>();

/**
 * Pure resolution: given a cwd, decide which runner copy to load and
 * (if project-local) where its ESM entry is. Filesystem reads happen
 * here so the dynamic-import side stays trivial; tests can stub `fsApi`.
 */
export interface RunnerResolution {
  source: "project" | "vendored";
  /** Absolute path to the project-local ESM entry. Present iff `source === "project"`. */
  entryPath?: string;
  /** `package.json#version` of the project-local runner. Present iff `source === "project"`. */
  version?: string;
  /** Reason vendored was chosen — useful for log surfacing in tests / debug. */
  vendoredReason?: "no-local-package" | "malformed-package-json" | "entry-missing";
}

/** Minimal `fs` surface this module needs. Injectable for hermetic tests. */
export interface RunnerFsApi {
  existsSync(p: string): boolean;
  readFileSync(p: string, encoding: "utf-8"): string;
}

export function resolveRunnerSource(
  cwd: string,
  fsApi: RunnerFsApi = fs as RunnerFsApi,
): RunnerResolution {
  const runnerDir = path.join(cwd, "node_modules", "@glubean", "runner");
  const pkgPath = path.join(runnerDir, "package.json");

  if (!fsApi.existsSync(pkgPath)) {
    return { source: "vendored", vendoredReason: "no-local-package" };
  }

  let pkg: { version?: string; exports?: unknown; main?: string; module?: string };
  try {
    pkg = JSON.parse(fsApi.readFileSync(pkgPath, "utf-8")) as typeof pkg;
  } catch {
    return { source: "vendored", vendoredReason: "malformed-package-json" };
  }

  const entryRel = pickEsmEntry(pkg);
  const entryAbs = path.resolve(runnerDir, entryRel);

  if (!fsApi.existsSync(entryAbs)) {
    return { source: "vendored", vendoredReason: "entry-missing" };
  }

  return { source: "project", entryPath: entryAbs, version: pkg.version };
}

/**
 * Pick the ESM entry path from a package.json. Prefers `exports["."].import`,
 * then top-level `exports["."]` if it's a string, then `module`, then `main`.
 * Falls back to `dist/index.js` as a last resort.
 */
function pickEsmEntry(pkg: {
  exports?: unknown;
  main?: string;
  module?: string;
}): string {
  const e = pkg.exports;
  if (e && typeof e === "object") {
    const root = (e as Record<string, unknown>)["."] ?? e;
    if (typeof root === "string") return root;
    if (root && typeof root === "object") {
      const r = root as Record<string, unknown>;
      if (typeof r["import"] === "string") return r["import"] as string;
      if (r["import"] && typeof r["import"] === "object") {
        const imp = r["import"] as Record<string, unknown>;
        if (typeof imp["default"] === "string") return imp["default"] as string;
      }
      if (typeof r["default"] === "string") return r["default"] as string;
    }
  }
  if (pkg.module) return pkg.module;
  if (pkg.main) return pkg.main;
  return "dist/index.js";
}

/**
 * Load the appropriate runner module for `cwd`. See module-level docstring
 * for resolution semantics. `log` (typically the extension's outputChannel)
 * receives one line describing which copy was used; pass `undefined` to
 * silence (e.g. in unit tests).
 */
export async function loadRunnerForCwd(
  cwd: string,
  log?: (msg: string) => void,
): Promise<RunnerModule> {
  const cached = _projectRunnerCache.get(cwd);
  if (cached) return cached;

  const res = resolveRunnerSource(cwd);
  let mod: RunnerModule;

  if (res.source === "project") {
    try {
      mod = (await import(pathToFileURL(res.entryPath!).href)) as RunnerModule;
      log?.(`runner: project-local @glubean/runner@${res.version ?? "?"} from ${res.entryPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.(`runner: project-local load failed (${msg}); falling back to vendored`);
      mod = await loadVendored();
      log?.(`runner: vendored @glubean/runner (after project-local failure)`);
    }
  } else {
    mod = await loadVendored();
    log?.(`runner: vendored @glubean/runner (${res.vendoredReason})`);
  }

  _projectRunnerCache.set(cwd, mod);
  return mod;
}

async function loadVendored(): Promise<RunnerModule> {
  if (!_vendoredRunner) {
    // Static specifier — esbuild externalizes (see `--external:@glubean/runner`),
    // Node resolves to `dist/node_modules/@glubean/runner`.
    _vendoredRunner = (await import("@glubean/runner")) as RunnerModule;
  }
  return _vendoredRunner;
}

/**
 * Test-only: clear the per-cwd cache so successive `loadRunnerForCwd()`
 * calls in tests don't see each other's results. Production code should
 * never need this — the cache is correct for the lifetime of a single
 * extension activation.
 */
export function _clearRunnerCacheForTests(): void {
  _projectRunnerCache.clear();
  _vendoredRunner = undefined;
}
