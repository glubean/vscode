/**
 * Pure logic for contract CodeLens computation.
 *
 * Extracted from `codeLensProvider.ts` so it can be unit-tested without
 * mocking the `vscode` module. The provider wraps these items in
 * `vscode.CodeLens` + `vscode.Range` at render time.
 */

import { extractContractCases } from "@glubean/scanner/static";

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
 * Compute contract lens items for a document's source content.
 *
 * Rules:
 * - Each contract case becomes one lens item at `caseLine - 1` (0-based).
 * - `deferred` → `⊘ deferred: <reason>` (disabled).
 * - `deprecated` → `⊘ deprecated: <reason>` (disabled). Takes precedence
 *   over `defaultRun` / `requires` since the user shouldn't be routed to
 *   "run anyway" on a case whose code is marked for removal.
 * - `requires: "browser" | "out-of-band"` → `⊘ requires: <cap>` (disabled).
 * - `defaultRun: "opt-in"` → `▶ run <key> (opt-in)` (runnable).
 * - Otherwise → `▶ run <key>` (runnable).
 *
 * @param content - Source of a `.contract.ts` file
 * @param filePath - Absolute path of the document (for run args)
 */
export function computeContractLenses(
  content: string,
  filePath: string,
): ContractLensItem[] {
  // Collect lens items from BOTH contract and flow markers — files may
  // export contracts, flows, or both (e.g. cookbook's flow.contract.ts).
  // Merging avoids losing one category when the other is present.
  const markerItems = [
    ...computeContractLensesByMarker(content, filePath),
    ...computeFlowLensesByMarker(content, filePath),
  ];
  if (markerItems.length > 0) return markerItems;

  // Fallback: old regex (contract.http("id", {))
  const items: ContractLensItem[] = [];
  const contracts = extractContractCases(content);

  for (const contract of contracts) {
    for (const c of contract.cases) {
      const line = c.line - 1;
      const testId = `${contract.contractId}.${c.key}`;

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
      const suffix = c.defaultRun === "opt-in" ? " (opt-in)" : "";
      items.push({ line, title: `\u25B6 run ${c.key}${suffix}`, kind: "run", args: { filePath, testId, exportName: contract.exportName } });
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

    const casesContent = afterCases.slice(braceIdx);
    const topLevelKeys: { key: string; offset: number }[] = [];
    let depth = 0;

    for (let j = 0; j < casesContent.length; j++) {
      if (casesContent[j] === "{") {
        if (depth === 1) {
          const before = casesContent.slice(0, j).trimEnd();
          const keyMatch = before.match(/["']?(\w+)["']?\s*:\s*$/);
          if (keyMatch) topLevelKeys.push({ key: keyMatch[1], offset: j });
        }
        depth++;
      } else if (casesContent[j] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }

    for (const { key, offset } of topLevelKeys) {
      const absolutePos = content.indexOf(nextLine) + casesStart + braceIdx + offset;
      const caseLine = content.substring(0, absolutePos).split("\n").length - 1; // 0-based

      // Extract case body
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

      const testId = `${contractId}.${key}`;

      if (deferredMatch) {
        items.push({ line: caseLine, title: `\u2298 deferred: ${deferredMatch[1]}`, kind: "disabled" });
      } else if (deprecatedMatch) {
        items.push({ line: caseLine, title: `\u2298 deprecated: ${deprecatedMatch[1]}`, kind: "disabled" });
      } else if (requiresMatch) {
        items.push({ line: caseLine, title: `\u2298 requires: ${requiresMatch[1]}`, kind: "disabled" });
      } else {
        const suffix = defaultRunMatch ? " (opt-in)" : "";
        items.push({ line: caseLine, title: `\u25B6 run ${key}${suffix}`, kind: "run", args: { filePath, testId, exportName } });
      }
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
    } else {
      items.push({
        line,
        title: `\u25B6 run ${flowId}`,
        kind: "run",
        args: { filePath, testId: flowId, exportName },
      });
    }
  }

  return items;
}
