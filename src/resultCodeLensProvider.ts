/**
 * CodeLens provider for result file viewing.
 *
 * Displays a "Results (N)" button on every test definition that has
 * at least one `.result.json` history file. Clicking opens the
 * latest result in a side-by-side editor.
 *
 * Works with all test patterns: test(), test.each(), test.pick(),
 * and *.bootstrap.ts overlay exports (redirected to target contract results).
 */

import * as vscode from "vscode";
import * as path from "path";
import {
  extractTests,
  isGlubeanFile,
  extractBootstrapMarkers,
  findImportPath,
  findContractIdInTarget,
} from "./parser";
import { countResultFiles } from "./resultNavigator";
import { normalizeFilterId } from "./testController.utils";
import { workspaceRootFor } from "./workspaceRoot";
import * as fs from "fs";

/**
 * Create a CodeLensProvider that shows "Results (N)" buttons on test definitions.
 */
export function createResultCodeLensProvider(): vscode.CodeLensProvider {
  return new ResultCodeLensProvider();
}

class ResultCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor() {
    // Refresh when documents are saved (new result files may have been written)
    vscode.workspace.onDidSaveTextDocument(() => {
      this._onDidChangeCodeLenses.fire();
    });
  }

  provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): vscode.CodeLens[] {
    const content = document.getText();
    if (!isGlubeanFile(content)) {
      return [];
    }

    const filePath = document.uri.fsPath;

    // Use workspaceRootFor (walks up to nearest package.json) so the results
    // path matches what the runner writes — raw getWorkspaceFolder() returns
    // the monorepo root (e.g. cookbook/) while results land under the package
    // root (e.g. cookbook/contract-first/).
    const workspaceRoot = workspaceRootFor(filePath);
    const fileName = path.basename(filePath);

    const lenses: vscode.CodeLens[] = [];

    // ── Standard tests (test(), contract cases, flows) ─────────────────────
    const tests = extractTests(content);
    for (const test of tests) {
      const line = test.line - 1; // 0-based for VS Code
      const range = new vscode.Range(line, 0, line, 0);
      const resultTestId = normalizeFilterId(test.id);
      lenses.push(...makeResultLenses(range, workspaceRoot, fileName, resultTestId));
    }

    // ── Bootstrap overlay exports — redirect to target contract's results ───
    // Bootstrap files have no test() calls so extractTests returns []. Each
    // overlay export (contract.bootstrap(IDENT.case("KEY"), ...)) runs the
    // TARGET contract case and writes results under the target contract file
    // name. We resolve the target here (same logic as resolveBootstrapShadows
    // in testController.ts) and show Results pointing at the target's history.
    if (tests.length === 0) {
      const markers = extractBootstrapMarkers(content);
      const dir = path.dirname(filePath);
      for (const marker of markers) {
        const importInfo = findImportPath(content, marker.targetIdent);
        let targetFilePath: string | undefined;
        let targetContent: string | undefined;
        let targetExportName: string | undefined;

        if (importInfo && importInfo.path.startsWith(".")) {
          const stripped = importInfo.path.replace(/\.(?:ts|js|mjs|tsx)$/, "");
          const base = path.resolve(dir, stripped);
          for (const ext of [".ts", ".tsx", ".mjs", ".js"]) {
            const candidate = `${base}${ext}`;
            try {
              targetContent = fs.readFileSync(candidate, "utf-8");
              targetFilePath = candidate;
              targetExportName = importInfo.originalName;
              break;
            } catch { /* next ext */ }
          }
        } else if (!importInfo) {
          // Same-file inline overlay
          targetContent = content;
          targetFilePath = filePath;
          targetExportName = marker.targetIdent;
        }

        if (!targetContent || !targetFilePath || !targetExportName) continue;
        const contractId = findContractIdInTarget(targetContent, targetExportName);
        if (!contractId) continue;

        const targetTestId = normalizeFilterId(`${contractId}.${marker.caseKey}`);
        const targetFileName = path.basename(targetFilePath);
        const line = marker.exportLine - 1; // 0-based
        const range = new vscode.Range(line, 0, line, 0);
        lenses.push(...makeResultLenses(range, workspaceRoot, targetFileName, targetTestId));
      }
    }

    return lenses;
  }
}

function makeResultLenses(
  range: vscode.Range,
  workspaceRoot: string,
  fileName: string,
  testId: string,
): vscode.CodeLens[] {
  const count = countResultFiles(workspaceRoot, fileName, testId);
  const title = count > 0 ? `$(history) Results (${count})` : "$(history) Results";
  return [
    new vscode.CodeLens(range, {
      title,
      command: "glubean.openResult",
      arguments: [{ workspaceRoot, fileName, testId }],
    }),
  ];
}
