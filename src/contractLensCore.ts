/**
 * Pure logic for contract CodeLens computation.
 *
 * Extracted from `codeLensProvider.ts` so it can be unit-tested without
 * mocking the `vscode` module. The provider wraps these items in
 * `vscode.CodeLens` + `vscode.Range` at render time.
 */

import * as nodePath from "node:path";
import {
  extractBootstrapMarkers as extractBootstrapMarkersAst,
  extractContracts,
  extractMarkedContracts,
  extractMarkedFlows,
  findContractIdInTarget as findContractIdInTargetAst,
  findImportPath as findImportPathAst,
} from "./contractAst";

/**
 * Glob patterns this provider's CodeLens applies to.
 *
 * Used both by `extension.ts` (to build the real `vscode.DocumentSelector`)
 * and by tests (to assert that `*.bootstrap.{ts,js,mjs}` is registered —
 * otherwise overlay lenses are computed correctly but never displayed).
 *
 * Three file kinds:
 *  - `*.contract.*` — contract.http()/contract.with() declarations
 *  - `*.flow.*`     — contract.flow() declarations
 *  - `*.bootstrap.*` — contract.bootstrap() overlay registrations
 *    (attachment-model §7.4)
 */
export const CONTRACT_LENS_FILE_PATTERNS = {
  typescript: [
    "**/*.contract.ts",
    "**/*.flow.ts",
    "**/*.bootstrap.ts",
  ],
  javascript: [
    "**/*.contract.{js,mjs}",
    "**/*.flow.{js,mjs}",
    "**/*.bootstrap.{js,mjs}",
  ],
} as const;

/**
 * Subset of `node:path` used by the cross-file overlay resolver. Injectable
 * so tests can pass `path.win32` to simulate Windows fsPaths on macOS/Linux
 * without needing a real Windows runner.
 */
export interface PathLib {
  dirname(p: string): string;
  join(...segments: string[]): string;
}

/**
 * A computed contract CodeLens item — shape only, no vscode types.
 *
 * - `line`: 0-based line number where the lens should render
 * - `title`: button label
 * - `kind`: `"run"` = clickable run button, `"disabled"` = info-only ⊘ lens
 * - `args`: present only for runnable items; the command argument payload
 */
export interface ContractLensItem {
  line: number;
  title: string;
  kind: "run" | "disabled";
  args?: {
    filePath: string;
    testId: string;
    exportName: string;
  };
}

/**
 * Read-file callback used by `computeContractLenses` to resolve cross-file
 * references (e.g. a `*.bootstrap.ts` importing the case it overlays from
 * a sibling `*.contract.ts`). The provider passes a real `fs.readFileSync`
 * wrapper; tests pass a `Map` for hermeticity.
 *
 * Returning `undefined` for a missing/unreadable file is fine — the
 * caller falls back to a disabled "couldn't resolve target" lens
 * rather than failing.
 */
export type ReadFileFn = (absolutePath: string) => string | undefined;

/**
 * Compute contract lens items for a document's source content.
 *
 * Lens output is **disabled-hints only** — running tests is owned by the
 * Test Explorer / gutter ▶ button, which is registered via `parser.ts` +
 * `testController.parseFile`. Duplicating the run action as a CodeLens
 * created visual noise and confused users into thinking they were two
 * different things; we keep CodeLens reserved for status flags the
 * gutter can't surface (deferred, deprecated, requires, skip, overlay
 * resolution failures).
 *
 * Rules:
 * - Default-runnable case → no lens (gutter ▶ runs it).
 * - `deferred` → `⊘ deferred: <reason>` (disabled).
 * - `deprecated` → `⊘ deprecated: <reason>` (disabled). Takes precedence
 *   over `defaultRun` / `requires` since the user shouldn't be routed to
 *   "run anyway" on a case whose code is marked for removal.
 * - `requires: "browser" | "out-of-band"` → `⊘ requires: <cap>` (disabled).
 *
 * For `*.bootstrap.ts` files (attachment-model overlays), the gutter ▶
 * button is materialized via `testController.parseFile` registering a
 * shadow TestItem. CodeLens only surfaces resolution failures
 * (`⊘ overlay: target file unreadable`, etc.) so the user sees why
 * an overlay isn't runnable when its target import or contract id can't
 * be resolved.
 *
 * @param content - Source of a `.contract.ts` / `.bootstrap.ts` file
 * @param filePath - Absolute path of the document (for run args)
 * @param readFile - Optional callback for cross-file resolution. When
 *   omitted, `computeBootstrapLensesByMarker` falls back to "best
 *   effort" mode: only resolves overlays whose import is a sibling
 *   `.contract.ts` file in the same directory (the canonical cookbook
 *   pattern); deeper resolution requires the callback.
 */
export function computeContractLenses(
  content: string,
  filePath: string,
  readFile?: ReadFileFn,
  pathLib: PathLib = nodePath,
): ContractLensItem[] {
  // Collect lens items from contract / flow / bootstrap markers — files
  // may export contracts, flows, overlays, or any combination.
  const markerItems = [
    ...computeContractLensesByMarker(content, filePath),
    ...computeFlowLensesByMarker(content, filePath),
    ...computeBootstrapLensesByMarker(content, filePath, readFile, pathLib),
  ];
  if (markerItems.length > 0) return markerItems;

  // Fallback: unmarked contract declarations such as `contract.http("id", {...})`.
  const items: ContractLensItem[] = [];
  const contracts = extractContracts(content);

  for (const contract of contracts) {
    for (const c of contract.cases) {
      const line = c.line - 1;
      if (c.deferred) {
        items.push({ line, title: `\u2298 deferred: ${c.deferred}`, kind: "disabled" });
        continue;
      }
      if (c.deprecated) {
        items.push({ line, title: `\u2298 deprecated: ${c.deprecated}`, kind: "disabled" });
        continue;
      }
      if (c.requires === "browser" || c.requires === "out-of-band") {
        items.push({ line, title: `\u2298 requires: ${c.requires}`, kind: "disabled" });
        continue;
      }
      // No runnable lens — gutter ▶ runs default cases.
    }
  }

  return items;
}

/**
 * Compute contract lenses from // @contract markers.
 * Supports contract.http.with() scoped instances.
 */
function computeContractLensesByMarker(
  content: string,
  filePath: string,
): ContractLensItem[] {
  const items: ContractLensItem[] = [];
  const contracts = extractMarkedContracts(content, filePath);

  for (const contract of contracts) {
    for (const c of contract.cases) {
      const caseLine = c.line - 1;

      if (c.deferred) {
        items.push({ line: caseLine, title: `\u2298 deferred: ${c.deferred}`, kind: "disabled" });
      } else if (c.deprecated) {
        items.push({ line: caseLine, title: `\u2298 deprecated: ${c.deprecated}`, kind: "disabled" });
      } else if (c.requires === "browser" || c.requires === "out-of-band") {
        items.push({ line: caseLine, title: `\u2298 requires: ${c.requires}`, kind: "disabled" });
      }
      // Default / opt-in cases emit no runnable lens — gutter ▶ owns the run action.
      void c.defaultRun;
    }
  }

  return items;
}

/**
 * Compute flow lenses from `// @flow` markers.
 *
 * Unlike contracts, a flow is a single runnable unit — there are no
 * per-case entries. One lens is emitted at the `export const` line with
 * the flow id as the test id (flow.contract.ts example:
 * `contract.flow("login-then-profile")...` → `testId: "login-then-profile"`).
 *
 * If the flow declares `.meta({ skip: "..." })` with a literal string
 * reason, the lens is rendered as `⊘ skip: <reason>` (disabled).
 *
 * Author conventions the detector relies on:
 *   - A `// @flow` comment line immediately above the export
 *   - `.flow("<id>")` call with a literal string id
 *   - Optional `.meta({ skip: "<reason>" })` with a literal string reason
 * More dynamic forms (e.g. `.flow(computedId())`) are not detected —
 * authors can fall back to the gutter Test Explorer play button.
 */
function computeFlowLensesByMarker(
  content: string,
  filePath: string,
): ContractLensItem[] {
  const items: ContractLensItem[] = [];
  const flows = extractMarkedFlows(content, filePath);

  for (const flow of flows) {
    if (flow.skip) {
      items.push({
        line: flow.line - 1,
        title: `\u2298 skip: ${flow.skip}`,
        kind: "disabled",
      });
    }
    // Flow runnable lens dropped — gutter ▶ on the flow's TestItem runs it.
  }

  return items;
}

// ===========================================================================
// Bootstrap (attachment-model v10 overlay) detector
// ===========================================================================
//
// Pattern (canonical cookbook example, contracts/attachment-model/me.bootstrap.ts):
//
//   import { getMe } from "./me.contract.ts";
//
//   export const meAuthorizedOverlay = contract.bootstrap(
//     getMe.case("authorized"),
//     async (ctx) => { ... },
//   );
//
// Resolvable overlays are represented by shadow TestItems in the gutter.
// CodeLens only surfaces resolution failures so authors can see why an
// overlay is not runnable from the Test Explorer.
//
// Resolution algorithm:
//   1. Find every `export const NAME = contract.bootstrap(IDENT.case("KEY"), ...)`
//   2. Find the import that brought IDENT in: `import ... { IDENT } from "PATH"`
//   3. If PATH is relative, resolve to an absolute path (same dir + .ts/.js)
//   4. Read the target file via the optional `readFile` callback
//   5. In that file, find `export const IDENT = <factory>("contract-id", { ... })`
//      to extract the contractId
//   6. If resolution succeeds, emit no CodeLens; if it fails, emit a disabled
//      diagnostic lens on the overlay export line
//
// Failure modes (each falls back to a disabled hint lens, not a hard error):
//   - Import not found → "⊘ overlay: target import not resolvable"
//   - Read fails → "⊘ overlay: target file unreadable"
//   - contractId not found → "⊘ overlay: target contract id not found"
//   - readFile callback omitted (test environments without fs) → fallback
//     hint lens

interface BootstrapMatch {
  exportName: string;
  exportLine: number;             // 0-based line of `export const`
  targetIdent: string;            // e.g. `getMe`
  caseKey: string;                // e.g. `authorized`
}

/**
 * Find all `contract.bootstrap(IDENT.case("KEY"), ...)` exports in the
 * file. Tolerates both inline and multi-line forms; the `.case("KEY")`
 * argument may be on a later line than `export const`.
 *
 * Search window is bounded by the NEXT `export const` (or EOF) so a
 * `contract.bootstrap()` declared in a later export doesn't get
 * misattributed to an earlier non-overlay export.
 */
function findBootstrapMatches(content: string): BootstrapMatch[] {
  return extractBootstrapMarkersAst(content).map((marker) => ({
    exportName: marker.exportName,
    exportLine: marker.exportLine - 1,
    targetIdent: marker.targetIdent,
    caseKey: marker.caseKey,
  }));
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
 * re-exports or barrel files — those fall through to the
 * disabled-hint lens path.
 */
function findImportPath(
  content: string,
  localIdent: string,
): { path: string; originalName: string } | undefined {
  return findImportPathAst(content, localIdent);
}

/**
 * Try to resolve a relative import path to an absolute file path on disk
 * by trying common extensions. Returns the first one that the readFile
 * callback returns content for, or undefined.
 *
 * `readFile` is the only filesystem dependency — keeps the function
 * deterministic + testable without mocking `fs`.
 */
function resolveImport(
  fromFile: string,
  importPath: string,
  readFile: ReadFileFn | undefined,
  pathLib: PathLib,
): { absPath: string; content: string } | undefined {
  if (!readFile) return undefined;
  if (!importPath.startsWith(".")) return undefined; // bare specifiers unsupported in v0

  // Strip a trailing `.ts` / `.js` / `.mjs` from the import path; we'll try
  // each extension. This handles `import ... from "./foo.contract.ts"`
  // (TS-style, with extension) AND `import ... from "./foo.contract"` (no ext).
  const stripped = importPath.replace(/\.(?:ts|js|mjs|tsx)$/, "");

  // `fromFile` is absolute; resolve relative to its directory using the
  // platform-native `node:path` (or `path.win32` injected by tests). The
  // earlier posix-only impl broke on Windows fsPaths (backslash separators)
  // — `posix.dirname("C:\\proj\\me.bootstrap.ts")` returns "." because
  // posix doesn't recognize "\\" as a separator, so every cross-file
  // overlay fell into the unreadable-file disabled hint.
  const dir = pathLib.dirname(fromFile);
  const base = pathLib.join(dir, stripped);

  for (const ext of [".ts", ".tsx", ".mjs", ".js"]) {
    const candidate = `${base}${ext}`;
    const content = readFile(candidate);
    if (content !== undefined) return { absPath: candidate, content };
  }
  return undefined;
}

/**
 * Find the contractId on a `// @contract`-marked export by name.
 * Returns the literal `"id"` from `<factory>("id", { ... })` or undefined.
 */
function findContractIdInTarget(
  content: string,
  exportName: string,
): string | undefined {
  return findContractIdInTargetAst(content, exportName);
}

/**
 * The bootstrap detector. Marker-free: runs on every `*.bootstrap.ts`
 * file (and any other file that happens to contain a
 * `contract.bootstrap(...)` export — e.g. inline overlay definitions in
 * a `.contract.ts` file).
 *
 * Why marker-free: the syntactic shape is distinctive enough
 * (`contract.bootstrap(IDENT.case("KEY"), ...)`) that we don't need a
 * `// @bootstrap` comment to disambiguate. Adding a marker would force
 * authors to remember a second comment convention.
 */
function computeBootstrapLensesByMarker(
  content: string,
  filePath: string,
  readFile: ReadFileFn | undefined,
  pathLib: PathLib,
): ContractLensItem[] {
  const items: ContractLensItem[] = [];
  const matches = findBootstrapMatches(content);

  for (const m of matches) {
    const importInfo = findImportPath(content, m.targetIdent);

    if (!importInfo) {
      // Inline overlay pattern: `contract.bootstrap()` lives in the SAME
      // file as the contract export it targets. Look it up locally — no
      // fs needed. Resolvable overlays stay silent because the gutter
      // shadow TestItem (registered by testController.parseFile) owns runs.
      const contractId = findContractIdInTarget(content, m.targetIdent);
      if (!contractId) {
        items.push({
          line: m.exportLine,
          title: `\u2298 overlay: target import not resolvable (${m.targetIdent}.case("${m.caseKey}"))`,
          kind: "disabled",
        });
      }
      // Resolvable overlays emit no runnable lens — the gutter ▶ on the
      // shadow TestItem (registered by testController.parseFile) runs it.
      continue;
    }

    const target = resolveImport(filePath, importInfo.path, readFile, pathLib);
    if (!target) {
      items.push({
        line: m.exportLine,
        title: `\u2298 overlay: target file unreadable (${importInfo.path})`,
        kind: "disabled",
      });
      continue;
    }

    // Look up the ORIGINAL exported name in the target (importInfo.originalName).
    // This handles `import { getMe as me } from "..."` — `m.targetIdent` is the
    // local alias `me`, but the target file still declares it as `getMe`.
    const contractId = findContractIdInTarget(target.content, importInfo.originalName);
    if (!contractId) {
      items.push({
        line: m.exportLine,
        title: `\u2298 overlay: target contract id not found in ${importInfo.path}`,
        kind: "disabled",
      });
      continue;
    }

    // Cross-file overlay resolved. The gutter shadow TestItem targets the
    // contract module/export, while CodeLens remains silent unless resolution
    // fails and the author needs a diagnostic hint.
    // Resolvable cross-file overlays emit no runnable lens — gutter ▶ on
    // the shadow TestItem (registered by testController.parseFile) runs it.
    void contractId;
    void target;
  }

  return items;
}
