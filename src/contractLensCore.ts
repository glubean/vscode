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
  // Try // @contract marker first (supports .with() syntax)
  const markerItems = computeContractLensesByMarker(content, filePath);
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
      const requiresMatch = caseBody.match(/requires\s*:\s*["'](browser|out-of-band)["']/);
      const defaultRunMatch = caseBody.match(/defaultRun\s*:\s*["'](opt-in)["']/);

      const testId = `${contractId}.${key}`;

      if (deferredMatch) {
        items.push({ line: caseLine, title: `\u2298 deferred: ${deferredMatch[1]}`, kind: "disabled" });
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
