/**
 * CodeLens provider for result file viewing.
 *
 * Displays a "Results (N)" button on every test definition that has
 * at least one `.result.json` history file. Clicking opens the
 * latest result in a side-by-side editor.
 *
 * Works with all test patterns: test(), test.each(), test.pick().
 */

import * as vscode from "vscode";
import * as path from "path";
import { extractTests, isGlubeanFile } from "./parser";
import { countResultFiles } from "./resultNavigator";
import { normalizeFilterId } from "./testController.utils";

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

    const tests = extractTests(content);
    if (tests.length === 0) {
      return [];
    }

    // Resolve workspace root for result directory lookup
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      return [];
    }
    const workspaceRoot = workspaceFolder.uri.fsPath;
    const fileName = path.basename(document.uri.fsPath);

    const lenses: vscode.CodeLens[] = [];

    for (const test of tests) {
      const line = test.line - 1; // 0-based for VS Code
      const range = new vscode.Range(line, 0, line, 0);

      // Normalize data-driven IDs so the lookup matches the written history key.
      const resultTestId = normalizeFilterId(test.id);

      const count = countResultFiles(workspaceRoot, fileName, resultTestId);

      if (count > 0) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: `$(history) Results (${count})`,
            command: "glubean.openResult",
            arguments: [
              {
                workspaceRoot,
                fileName,
                testId: resultTestId,
              },
            ],
          }),
        );
      } else {
        // No results yet — show a dimmed hint
        lenses.push(
          new vscode.CodeLens(range, {
            title: "$(history) Results",
            command: "glubean.openResult",
            arguments: [
              {
                workspaceRoot,
                fileName,
                testId: resultTestId,
              },
            ],
          }),
        );
      }
    }

    return lenses;
  }
}
