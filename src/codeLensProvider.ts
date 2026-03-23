/**
 * CodeLens provider for:
 * 1. test.pick() example selection buttons
 * 2. Data loader "Open data" buttons (fromDir, fromYaml, fromCsv, etc.)
 *
 * Pick buttons appear above test.pick() calls.
 * Data loader buttons appear above from*() / import ... .json calls.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { extractPickExamples, type PickMeta } from "@glubean/scanner/static";
import { parse as parseYaml } from "yaml";
import { getAliases } from "./testController";
import { findDataLoaderCalls } from "./dataLoaderCalls";
import { resolveDataPath } from "./data-path";
import { extractTests } from "./parser";
import { detectRefactorScenarios } from "./aiRefactor";

/** Max individual key buttons before collapsing into a QuickPick button */
const QUICK_PICK_THRESHOLD = 5;

/** Supported data file extensions */
const DATA_EXTS = [".json", ".yaml", ".yml", ".csv", ".jsonl"];

/**
 * Create a CodeLensProvider for test.pick() example buttons.
 *
 * @param runPickCommandId The command ID to execute when a CodeLens is clicked
 * @param pickAndRunCommandId The command ID for QuickPick selection (many keys)
 */
export interface PickCodeLens extends vscode.CodeLensProvider, vscode.Disposable {
  /** Mark a test as running — CodeLens will show a spinner. */
  setRunning(filePath: string, testId: string): void;
  /** Clear running state — CodeLens reverts to normal. */
  clearRunning(filePath: string, testId: string): void;
}

export function createPickCodeLensProvider(
  runPickCommandId: string,
  pickAndRunCommandId: string,
): PickCodeLens {
  return new PickCodeLensProvider(runPickCommandId, pickAndRunCommandId);
}

/**
 * Build a CodeLens for a data loader call.
 */
function buildDataLoaderLens(
  call: { line: number; target: "file" | "dir"; resolvedPath: string },
): vscode.CodeLens {
  const range = new vscode.Range(call.line, 0, call.line, 0);

  if (call.target === "file") {
    if (!fs.existsSync(call.resolvedPath)) {
      return new vscode.CodeLens(range, {
        title: "$(warning) Invalid data file path",
        command: "",
      });
    }
    return new vscode.CodeLens(range, {
      title: "$(file) Open data",
      command: "glubean.openDataFile",
      arguments: [vscode.Uri.file(call.resolvedPath)],
    });
  }

  // Directory target
  const dirPath = call.resolvedPath.endsWith("/")
    ? call.resolvedPath.slice(0, -1)
    : call.resolvedPath;

  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    return new vscode.CodeLens(range, {
      title: "$(warning) Invalid data folder path",
      command: "",
    });
  }

  const files = fs
    .readdirSync(dirPath)
    .filter((f) => DATA_EXTS.some((ext) => f.endsWith(ext)))
    .sort();

  if (files.length === 0) {
    return new vscode.CodeLens(range, {
      title: "$(warning) No data files in folder",
      command: "",
    });
  }

  const firstFile = path.join(dirPath, files[0]);
  return new vscode.CodeLens(range, {
    title: `$(folder) Open data (${files.length} files)`,
    command: "glubean.openDataFile",
    arguments: [vscode.Uri.file(firstFile)],
  });
}

// ---------------------------------------------------------------------------
// Main CodeLens provider
// ---------------------------------------------------------------------------

class PickCodeLensProvider implements PickCodeLens {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  private saveListener: vscode.Disposable;
  private dataWatcher: vscode.FileSystemWatcher;
  private running = new Set<string>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(
    private readonly runPickCommandId: string,
    private readonly pickAndRunCommandId: string,
  ) {
    // Refresh CodeLenses when documents are saved (keys may have changed)
    this.saveListener = vscode.workspace.onDidSaveTextDocument(() => {
      this._onDidChangeCodeLenses.fire();
    });

    // Watch data directories for file changes (create/delete/modify)
    this.dataWatcher = vscode.workspace.createFileSystemWatcher(
      "**/data/**/*.{json,yaml,yml,csv,jsonl}",
    );
    this.dataWatcher.onDidCreate(() => this._onDidChangeCodeLenses.fire());
    this.dataWatcher.onDidDelete(() => this._onDidChangeCodeLenses.fire());
    this.dataWatcher.onDidChange(() => this._onDidChangeCodeLenses.fire());
  }

  private runKey(filePath: string, testId: string): string {
    return `${filePath}::${testId}`;
  }

  setRunning(filePath: string, testId: string): void {
    this.running.add(this.runKey(filePath, testId));
    this._onDidChangeCodeLenses.fire();
  }

  clearRunning(filePath: string, testId: string): void {
    this.running.delete(this.runKey(filePath, testId));
    this._onDidChangeCodeLenses.fire();
  }

  dispose(): void {
    this.saveListener.dispose();
    this.dataWatcher.dispose();
    this._onDidChangeCodeLenses.dispose();
  }

  provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];

    // ── Data loader CodeLenses (independent of test.pick) ──────────────
    const dataLoaderCalls = findDataLoaderCalls(document.getText(), {
      filePath: document.uri.fsPath,
      workspaceRoot: vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ??
        path.dirname(document.uri.fsPath),
    });
    for (const call of dataLoaderCalls) {
      lenses.push(buildDataLoaderLens(call));
    }

    // ── Pick example CodeLenses ────────────────────────────────────────
    const content = document.getText();
    // Keep scanner output raw here. VSCode resolves file/project-root paths
    // with its own workspace context before opening files or loading keys.
    const pickMetas = extractPickExamples(content, {
      customFns: getAliases(),
    });

    for (const meta of pickMetas) {
      const line = meta.line - 1; // 0-based for VS Code
      const range = new vscode.Range(line, 0, line, 0);

      // Show spinner if this test is currently running
      if (this.running.has(this.runKey(document.uri.fsPath, meta.testId))) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: "$(sync~spin) Running\u2026",
            command: "",
          }),
        );
        continue;
      }

      // Resolve keys (may require reading JSON/YAML file from disk)
      const keys = this.resolveKeys(meta, document);

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
          }),
        );

        if (keys.length <= QUICK_PICK_THRESHOLD) {
          for (const key of keys) {
            lenses.push(
              new vscode.CodeLens(range, {
                title: `\u25B6 ${key}`,
                command: this.runPickCommandId,
                arguments: [{ ...baseArgs, pickKey: key }],
              }),
            );
          }
        } else {
          lenses.push(
            new vscode.CodeLens(range, {
              title: `\u25B6 Pick example\u2026 (${keys.length})`,
              command: this.pickAndRunCommandId,
              arguments: [{ ...baseArgs, keys }],
            }),
          );
        }
      } else {
        // Could not resolve keys — show format hint
        lenses.push(
          new vscode.CodeLens(range, {
            title:
              "test.pick: use inline object or JSON import for CodeLens buttons",
            command: "",
          }),
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
          }),
        );
      }
    }

    // ── AI Refactor CodeLenses ──────────────────────────────────────────
    const tests = extractTests(content);
    for (const meta of tests) {
      const scenarios = detectRefactorScenarios(
        content,
        document.uri.fsPath,
        meta,
      );
      if (scenarios.length > 0) {
        const line = meta.line - 1; // 0-based for VS Code
        const range = new vscode.Range(line, 0, line, 0);
        lenses.push(
          new vscode.CodeLens(range, {
            title: "💡 Refactor",
            command: "glubean.aiRefactor",
            arguments: [
              {
                filePath: document.uri.fsPath,
                exportName: meta.exportName,
                testId: meta.id,
                line: meta.line,
                scenarios,
              },
            ],
          }),
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
    document: vscode.TextDocument,
  ): string[] | null {
    // Already resolved by parser (inline object literal)
    if (meta.keys) {
      return meta.keys;
    }

    // JSON import: read file and extract keys
    if (meta.dataSource?.type === "json-import") {
      return this.resolveJsonImportKeys(meta.dataSource.path, document);
    }

    // Directory merge: read all data files in the directory, merge keys
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
    document: vscode.TextDocument,
  ): string[] | null {
    try {
      const filePath = document.uri.fsPath;
      const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ??
        path.dirname(filePath);
      const resolvedPath = resolveDataPath(jsonPath, {
        sourceFilePath: filePath,
        workspaceRoot,
      }).resolvedPath;

      const content = fs.readFileSync(resolvedPath, "utf-8");
      const data = JSON.parse(content);

      if (data && typeof data === "object" && !Array.isArray(data)) {
        return Object.keys(data);
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Read all data files in a directory, merge their top-level keys
   * in alphabetical order (matching SDK's _collectAndSort + Object.assign).
   *
   * Resolves the path relative to the workspace folder containing the document.
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
      const resolvedDir = resolveDataPath(dirPath, {
        sourceFilePath: document.uri.fsPath,
        workspaceRoot: baseDir,
      }).resolvedPath;

      if (
        !fs.existsSync(resolvedDir) ||
        !fs.statSync(resolvedDir).isDirectory()
      ) {
        return null;
      }

      const LOCAL_SUFFIX = ".local.";
      const allFiles = fs
        .readdirSync(resolvedDir)
        .filter((f) => DATA_EXTS.some((ext) => f.endsWith(ext)));
      const shared = allFiles
        .filter((f) => !f.includes(LOCAL_SUFFIX))
        .sort();
      const local = allFiles.filter((f) => f.includes(LOCAL_SUFFIX)).sort();
      const files = [...shared, ...local];

      const merged: Record<string, unknown> = {};
      for (const file of files) {
        const filePath = path.join(resolvedDir, file);
        try {
          const content = fs.readFileSync(filePath, "utf-8");
          let data: unknown;
          if (file.endsWith(".json")) {
            data = JSON.parse(content);
          } else if (file.endsWith(".yaml") || file.endsWith(".yml")) {
            data = parseYaml(content);
          } else {
            // CSV/JSONL: array-like, no named keys for merge — skip
            continue;
          }
          if (data && typeof data === "object" && !Array.isArray(data)) {
            Object.assign(merged, data as Record<string, unknown>);
          }
        } catch {
          // Skip files that can't be parsed
        }
      }

      const keys = Object.keys(merged);
      return keys.length > 0 ? keys : null;
    } catch {
      return null;
    }
  }
}
