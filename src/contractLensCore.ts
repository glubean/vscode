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
  const items: ContractLensItem[] = [];
  const contracts = extractContractCases(content);

  for (const contract of contracts) {
    for (const c of contract.cases) {
      const line = c.line - 1; // caseLine is 1-based; editor rows are 0-based
      const testId = `${contract.contractId}.${c.key}`;

      if (c.deferred) {
        items.push({
          line,
          title: `\u2298 deferred: ${c.deferred}`,
          kind: "disabled",
        });
        continue;
      }

      if (c.requires === "browser" || c.requires === "out-of-band") {
        items.push({
          line,
          title: `\u2298 requires: ${c.requires}`,
          kind: "disabled",
        });
        continue;
      }

      const suffix = c.defaultRun === "opt-in" ? " (opt-in)" : "";
      items.push({
        line,
        title: `\u25B6 run ${c.key}${suffix}`,
        kind: "run",
        args: {
          filePath,
          testId,
          exportName: contract.exportName,
        },
      });
    }
  }

  return items;
}
