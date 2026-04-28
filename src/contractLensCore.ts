/**
 * Pure logic for contract CodeLens computation.
 *
 * Extracted from `codeLensProvider.ts` so it can be unit-tested without
 * mocking the `vscode` module. The provider wraps these items in
 * `vscode.CodeLens` + `vscode.Range` at render time.
 */

import * as nodePath from "node:path";
import { extractContractCases } from "@glubean/scanner/static";

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

  // Fallback: old regex (contract.http("id", {))
  const items: ContractLensItem[] = [];
  const contracts = extractContractCases(content);

  for (const contract of contracts) {
    for (const c of contract.cases) {
      const line = c.line - 1;
      if (c.deferred) {
        items.push({ line, title: `\u2298 deferred: ${c.deferred}`, kind: "disabled" });
        continue;
      }
      // Note: scanner's static `extractContractCases` declares `deprecated` on
      // the type but does not yet populate it — only the marker path detects
      // deprecated. Covered by `computeContractLensesByMarker` below.
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
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    if (!/\/\/\s*@contract\s*$/.test(lines[i])) continue;

    const nextLine = lines[i + 1];
    if (!nextLine) continue;
    const exportMatch = nextLine.match(/export\s+const\s+(\w+)/);
    if (!exportMatch) continue;
    const exportName = exportMatch[1];

    // Find contract body
    const afterExport = content.slice(content.indexOf(nextLine));
    const idMatch = afterExport.match(/\(\s*["']([^"']+)["']\s*,\s*\{/);
    if (!idMatch) continue;
    const contractId = idMatch[1];

    // Find cases block
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
    // Both must produce a clickable lens. Pre-fix only inline was
    // supported; shorthand-only contract files had ZERO CodeLens entries.
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
        // Top-level segment boundary. If the segment didn't open an
        // inline body, treat it as a shorthand identifier.
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
      const absolutePos = content.indexOf(nextLine) + casesStart + braceIdx + offset;
      const caseLine = content.substring(0, absolutePos).split("\n").length - 1; // 0-based
      const testId = `${contractId}.${key}`;

      if (shorthand) {
        // Shorthand cases reference `defineHttpCase()` declared elsewhere —
        // we have no inline body to scan for deferred/requires/skip flags,
        // so no lens is emitted. Gutter ▶ runs the case.
        void caseLine;
        void testId;
        void exportName;
        continue;
      }

      // Inline case — scan its body for metadata that controls lens shape.
      let caseDepth = 0;
      let caseEnd = offset;
      for (let j = offset; j < casesContent.length; j++) {
        if (casesContent[j] === "{") caseDepth++;
        else if (casesContent[j] === "}") { caseDepth--; if (caseDepth === 0) { caseEnd = j; break; } }
      }
      const caseBody = casesContent.slice(offset, caseEnd + 1);

      const deferredMatch = caseBody.match(/deferred\s*:\s*["']([^"']+)["']/);
      const deprecatedMatch = caseBody.match(/deprecated\s*:\s*["']([^"']+)["']/);
      const requiresMatch = caseBody.match(/requires\s*:\s*["'](browser|out-of-band)["']/);
      const defaultRunMatch = caseBody.match(/defaultRun\s*:\s*["'](opt-in)["']/);

      if (deferredMatch) {
        items.push({ line: caseLine, title: `\u2298 deferred: ${deferredMatch[1]}`, kind: "disabled" });
      } else if (deprecatedMatch) {
        items.push({ line: caseLine, title: `\u2298 deprecated: ${deprecatedMatch[1]}`, kind: "disabled" });
      } else if (requiresMatch) {
        items.push({ line: caseLine, title: `\u2298 requires: ${requiresMatch[1]}`, kind: "disabled" });
      }
      // Default / opt-in cases emit no runnable lens — gutter ▶ owns the run action.
      void defaultRunMatch;
      void key;
      void testId;
      void exportName;
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
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    if (!/\/\/\s*@flow\s*$/.test(lines[i])) continue;

    const nextLine = lines[i + 1];
    if (!nextLine) continue;
    const exportMatch = nextLine.match(/export\s+const\s+(\w+)/);
    if (!exportMatch) continue;
    const exportName = exportMatch[1];

    // Find .flow("<id>") anywhere in the tail of the file from the export
    // line onwards. This tolerates the canonical multi-line style
    // (`contract\n  .flow("id")\n  .meta(...)\n  .step(...)`) where the
    // call sits on a later line than `export const`.
    const afterExport = content.slice(content.indexOf(nextLine));
    const flowIdMatch = afterExport.match(/\.flow\s*\(\s*["']([^"']+)["']/);
    if (!flowIdMatch) continue;
    const flowId = flowIdMatch[1];

    // Scope the .meta({...}) search to the first call on this export —
    // a reasonable approximation that avoids crossing into later exports.
    // Matches `.meta({ ... skip: "reason" ... })` with a literal string.
    const metaCall = afterExport.match(/\.meta\s*\(\s*\{([\s\S]*?)\}\s*\)/);
    const skipMatch = metaCall?.[1].match(/skip\s*:\s*["']([^"']+)["']/);

    // Lens renders at the `export const` line (0-based).
    const line = i + 1;

    if (skipMatch) {
      items.push({
        line,
        title: `\u2298 skip: ${skipMatch[1]}`,
        kind: "disabled",
      });
    }
    // Flow runnable lens dropped — gutter ▶ on the flow's TestItem runs it.
    void flowId;
    void exportName;
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
// One CodeLens above each `contract.bootstrap(...)` export. Clicking it
// runs the **target case** (`getMe.case("authorized")` resolves at
// runtime to testId `auth.me.authorized`) — the overlay registers
// automatically thanks to §7.4 eager-load in the harness.
//
// Resolution algorithm:
//   1. Find every `export const NAME = contract.bootstrap(IDENT.case("KEY"), ...)`
//   2. Find the import that brought IDENT in: `import ... { IDENT } from "PATH"`
//   3. If PATH is relative, resolve to an absolute path (same dir + .ts/.js)
//   4. Read the target file via the optional `readFile` callback
//   5. In that file, find `export const IDENT = <factory>("contract-id", { ... })`
//      to extract the contractId
//   6. Build `testId = "${contractId}.${KEY}"` and emit a runnable lens
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
  const lines = content.split("\n");
  const matches: BootstrapMatch[] = [];

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

    // Slice the export body — from `export const` line (inclusive) to
    // the line BEFORE the next `export const`. Bounds the window so
    // a sibling overlay isn't credited to a preceding non-overlay export.
    const body = lines.slice(i, endLine).join("\n");

    const bsMatch = body.match(
      /\bcontract\s*\.\s*bootstrap\s*\(\s*(\w+)\s*\.\s*case\s*\(\s*["']([^"']+)["']\s*\)/,
    );
    if (!bsMatch) continue;

    matches.push({
      exportName,
      exportLine: i,
      targetIdent: bsMatch[1],
      caseKey: bsMatch[2],
    });
  }

  return matches;
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
  // Match `export const NAME = X("id", {` where X may be a chain like
  // `dummyApi("id", {)` — we only need the first string literal arg.
  const escaped = exportName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    String.raw`export\s+const\s+${escaped}\s*=\s*[\w.]+\s*\(\s*["']([^"']+)["']\s*,`,
  );
  const m = content.match(re);
  return m?.[1];
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
      // fs needed. The runnable lens points at THIS file, but the
      // exportName is the contract's own export (`m.targetIdent`), not
      // the overlay's. Why: clicking the lens spawns a harness scoped
      // to `{ filePath, exportName, testId }` — the harness needs to
      // resolve a `Test`/`Contract`, not a `BootstrapAttachment`.
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

    // Cross-file overlay: the runnable lens must point at the **target
    // contract module** (`target.absPath`) and use the **target's
    // contract export name** (`importInfo.originalName`) — NOT the
    // bootstrap file or the overlay export. Otherwise the harness
    // imports `me.bootstrap.ts` and looks up `meAuthorizedOverlay`,
    // which is a `BootstrapAttachment`, not a `Test` — `findTestById`
    // returns undefined and the click silently fails. The overlay
    // still registers because §7.4 eager-load runs `loadProjectOverlays`
    // for every `*.bootstrap.ts` file regardless of which file the
    // harness was spawned to test.
    // Resolvable cross-file overlays emit no runnable lens — gutter ▶ on
    // the shadow TestItem (registered by testController.parseFile) runs it.
    void contractId;
    void target;
  }

  return items;
}
