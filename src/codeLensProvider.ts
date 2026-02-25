/**
 * CodeLens provider for test.pick() example selection.
 *
 * Displays clickable buttons above test.pick() calls:
 * - When example keys are resolved: "Run (random) | key1 | key2 | key3"
 * - When keys cannot be resolved: a hint about the expected format
 *
 * Keys are resolved from:
 * 1. Inline object literals in the source code
 * 2. JSON import files (read from disk at render time)
 * 3. Directory merge via fromDir.merge (reads all JSON files in a directory)
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { extractPickExamples, isGlubeanFile, type PickMeta } from "./parser";

/** Max individual key buttons before collapsing into a QuickPick button */
const QUICK_PICK_THRESHOLD = 5;

/**
 * Create a CodeLensProvider for test.pick() example buttons.
 *
 * @param runPickCommandId The command ID to execute when a CodeLens is clicked
 * @param pickAndRunCommandId The command ID for QuickPick selection (many keys)
 */
export function createPickCodeLensProvider(
  runPickCommandId: string,
  pickAndRunCommandId: string,
): vscode.CodeLensProvider & vscode.Disposable {
  return new PickCodeLensProvider(runPickCommandId, pickAndRunCommandId);
}

class PickCodeLensProvider
  implements vscode.CodeLensProvider, vscode.Disposable
{
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  private saveListener: vscode.Disposable;
  private dataWatcher: vscode.FileSystemWatcher;
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(
    private readonly runPickCommandId: string,
    private readonly pickAndRunCommandId: string,
  ) {
    // Refresh CodeLenses when documents are saved (keys may have changed)
    this.saveListener = vscode.workspace.onDidSaveTextDocument(() => {
      this._onDidChangeCodeLenses.fire();
    });

    // Watch data directories for JSON file changes (create/delete/modify)
    // so CodeLens updates when users add/remove *.local.json files
    this.dataWatcher = vscode.workspace.createFileSystemWatcher(
      "**/data/**/*.json",
    );
    this.dataWatcher.onDidCreate(() => this._onDidChangeCodeLenses.fire());
    this.dataWatcher.onDidDelete(() => this._onDidChangeCodeLenses.fire());
    this.dataWatcher.onDidChange(() => this._onDidChangeCodeLenses.fire());
  }

  dispose(): void {
    this.saveListener.dispose();
    this.dataWatcher.dispose();
    this._onDidChangeCodeLenses.dispose();
  }

  provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.CodeLens[] {
    const content = document.getText();
    if (!isGlubeanFile(content)) {
      return [];
    }

    const pickMetas = extractPickExamples(content);
    if (pickMetas.length === 0) {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];

    for (const meta of pickMetas) {
      // Resolve keys (may require reading JSON file from disk)
      const keys = this.resolveKeys(meta, document);
      const line = meta.line - 1; // 0-based for VS Code
      const range = new vscode.Range(line, 0, line, 0);

      if (keys && keys.length > 0) {
        const baseArgs = {
          filePath: document.uri.fsPath,
          testId: meta.testId,
          exportName: meta.exportName,
        };

        // "Run (random)" button — no pick key, SDK picks randomly
        lenses.push(
          new vscode.CodeLens(range, {
            title: "\u25B6 Run (random)",
            command: this.runPickCommandId,
            arguments: [baseArgs],
          })
        );

        if (keys.length <= QUICK_PICK_THRESHOLD) {
          // Few keys: one button per example
          for (const key of keys) {
            lenses.push(
              new vscode.CodeLens(range, {
                title: `\u25B6 ${key}`,
                command: this.runPickCommandId,
                arguments: [{ ...baseArgs, pickKey: key }],
              })
            );
          }
        } else {
          // Many keys: single button that opens a QuickPick
          lenses.push(
            new vscode.CodeLens(range, {
              title: `\u25B6 Pick example\u2026 (${keys.length})`,
              command: this.pickAndRunCommandId,
              arguments: [{ ...baseArgs, keys }],
            })
          );
        }
      } else {
        // Could not resolve keys — show format hint
        lenses.push(
          new vscode.CodeLens(range, {
            title:
              "test.pick: use inline object or JSON import for CodeLens buttons",
            command: "",
          })
        );

        // Still offer a "Run (random)" button
        lenses.push(
          new vscode.CodeLens(range, {
            title: "\u25B6 Run (random)",
            command: this.runPickCommandId,
            arguments: [
              {
                filePath: document.uri.fsPath,
                testId: meta.testId,
                exportName: meta.exportName,
              },
            ],
          })
        );
      }
    }

    return lenses;
  }

  /**
   * Resolve example keys for a PickMeta entry.
   *
   * - Inline keys: already extracted by the parser
   * - JSON import: read the file from disk and extract Object.keys()
   * - Unknown: return null
   */
  private resolveKeys(
    meta: PickMeta,
    document: vscode.TextDocument
  ): string[] | null {
    // Already resolved by parser (inline object literal)
    if (meta.keys) {
      return meta.keys;
    }

    // JSON import: read file and extract keys
    if (meta.dataSource?.type === "json-import") {
      return this.resolveJsonImportKeys(meta.dataSource.path, document);
    }

    // Directory merge: read all JSON files in the directory, merge keys
    if (meta.dataSource?.type === "dir-merge") {
      return this.resolveDirMergeKeys(meta.dataSource.path, document);
    }

    return null;
  }

  /**
   * Read a JSON file and return its top-level keys.
   * Resolves the path relative to the document's directory.
   */
  private resolveJsonImportKeys(
    jsonPath: string,
    document: vscode.TextDocument
  ): string[] | null {
    try {
      // Resolve relative path against the document's directory
      const docDir = path.dirname(document.uri.fsPath);
      const resolvedPath = path.resolve(docDir, jsonPath);

      const content = fs.readFileSync(resolvedPath, "utf-8");
      const data = JSON.parse(content);

      if (data && typeof data === "object" && !Array.isArray(data)) {
        return Object.keys(data);
      }

      // JSON root is not an object (e.g. array) — can't extract named keys
      return null;
    } catch {
      // File not found, parse error, etc.
      return null;
    }
  }

  /**
   * Read all JSON files in a directory, merge their top-level keys
   * in alphabetical order (matching SDK's _collectAndSort + Object.assign).
   *
   * The test file may use a CWD-relative path (e.g. "./data/add-product/").
   * Since tests run from the project root, we resolve relative to the
   * workspace folder containing the document (not the document's own dir).
   */
  private resolveDirMergeKeys(
    dirPath: string,
    document: vscode.TextDocument,
  ): string[] | null {
    try {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
      const baseDir = workspaceFolder
        ? workspaceFolder.uri.fsPath
        : path.dirname(document.uri.fsPath);
      const resolvedDir = path.resolve(baseDir, dirPath);

      if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
        return null;
      }

      const LOCAL_SUFFIX = ".local.";
      const allJson = fs
        .readdirSync(resolvedDir)
        .filter((f) => f.endsWith(".json"));
      const shared = allJson.filter((f) => !f.includes(LOCAL_SUFFIX)).sort();
      const local = allJson.filter((f) => f.includes(LOCAL_SUFFIX)).sort();
      const files = [...shared, ...local];

      const merged: Record<string, unknown> = {};
      for (const file of files) {
        const filePath = path.join(resolvedDir, file);
        const content = fs.readFileSync(filePath, "utf-8");
        const data = JSON.parse(content);
        if (data && typeof data === "object" && !Array.isArray(data)) {
          Object.assign(merged, data);
        }
      }

      const keys = Object.keys(merged);
      return keys.length > 0 ? keys : null;
    } catch {
      return null;
    }
  }
}
