/**
 * CodeLens provider for trace file viewing.
 *
 * Displays a "Trace (N)" button on every test definition that has
 * at least one `.trace.jsonc` history file. Clicking opens the
 * latest trace in a side-by-side editor.
 *
 * Works with all test patterns: test(), test.each(), test.pick().
 */

import * as vscode from "vscode";
import * as path from "path";
import { extractTests, isGlubeanFile } from "./parser";
import { countTraceFiles } from "./traceNavigator";

/**
 * Create a CodeLensProvider that shows "Trace (N)" buttons on test definitions.
 */
export function createTraceCodeLensProvider(): vscode.CodeLensProvider {
  return new TraceCodeLensProvider();
}

class TraceCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor() {
    // Refresh when documents are saved (new trace files may have been written)
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

    // Resolve workspace root for trace directory lookup
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

      // Resolve the testId used for trace directory name.
      // For test.each/test.pick, the parser prefixes with "each:" or "pick:" —
      // but the CLI uses the raw pattern as the testId in the trace path.
      // We need to strip that prefix.
      let traceTestId = test.id;
      if (traceTestId.startsWith("each:")) {
        traceTestId = traceTestId.slice(5);
      } else if (traceTestId.startsWith("pick:")) {
        traceTestId = traceTestId.slice(5);
      }

      const count = countTraceFiles(workspaceRoot, fileName, traceTestId);

      if (count > 0) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: `$(history) Trace (${count})`,
            command: "glubean.openTrace",
            arguments: [
              {
                workspaceRoot,
                fileName,
                testId: traceTestId,
              },
            ],
          }),
        );
      } else {
        // No traces yet — show a dimmed hint
        lenses.push(
          new vscode.CodeLens(range, {
            title: "$(history) Trace",
            command: "glubean.openTrace",
            arguments: [
              {
                workspaceRoot,
                fileName,
                testId: traceTestId,
              },
            ],
          }),
        );
      }
    }

    return lenses;
  }
}
