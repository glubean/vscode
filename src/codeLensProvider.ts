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
import { computeContractLenses } from "./contractLensCore";
import { parse as parseYaml } from "yaml";
import { getAliases } from "./testController";
import { findDataLoaderCalls } from "./dataLoaderCalls";
import { resolveDataPath } from "./data-path";
import {
  extractTests,
  extractBootstrapMarkers,
  findImportPath,
  findContractIdInTarget,
} from "./parser";
import { detectRefactorScenarios } from "./aiRefactor";
import { workspaceRootFor } from "./workspaceRoot";
import { listPinned, isPinned } from "./pinnedFiles";
import { listPinnedTests, isPinnedTest } from "./pinnedTests";

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
    // Resolve relative data paths against the project package root, NOT
    // the VSCode workspace folder. In a monorepo cookbook layout the user
    // typically opens `cookbook/` as the workspace, but `data/...` lives
    // inside `cookbook/test-after/` (the package dir). Using the workspace
    // folder caused "Invalid data folder path" warnings on every recipe
    // that used relative dir/file paths.
    const dataLoaderCalls = findDataLoaderCalls(document.getText(), {
      filePath: document.uri.fsPath,
      workspaceRoot: workspaceRootFor(document.uri.fsPath),
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

    // ── Pin CodeLens (top of file, if not already pinned) ──────────────
    const wsFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (wsFolder) {
      const wsRoot = wsFolder.uri.fsPath;
      const relPath = vscode.workspace.asRelativePath(document.uri, false);
      if (!isPinned(listPinned(), wsRoot, relPath)) {
        const topRange = new vscode.Range(0, 0, 0, 0);
        lenses.push(
          new vscode.CodeLens(topRange, {
            title: "$(pin) Pin to Glubean",
            command: "glubean.pinFile",
            arguments: [document.uri],
          }),
        );
      }
    }

    // ── AI Refactor CodeLenses ──────────────────────────────────────────
    const tests = extractTests(content);
    const scenarios = detectRefactorScenarios("", "", { type: "test", id: "", exportName: "", line: 0 });
    for (const meta of tests) {
      const line = meta.line - 1; // 0-based for VS Code
      const range = new vscode.Range(line, 0, line, 0);
      lenses.push(
        new vscode.CodeLens(range, {
          title: "$(lightbulb)",
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

    // ── Pin Test CodeLenses (per-test, if not already pinned) ──────────
    if (wsFolder) {
      const wsRoot = wsFolder.uri.fsPath;
      const relPath = vscode.workspace.asRelativePath(document.uri, false);
      const currentPinnedTests = listPinnedTests();

      for (const meta of tests) {
        if (!isPinnedTest(currentPinnedTests, wsRoot, relPath, meta.id)) {
          const line = meta.line - 1; // 0-based for VS Code
          const range = new vscode.Range(line, 0, line, 0);
          lenses.push(
            new vscode.CodeLens(range, {
              title: "$(pin) Pin",
              command: "glubean.pinTest",
              arguments: [
                {
                  uri: document.uri,
                  testId: meta.id,
                  exportName: meta.exportName,
                  label: meta.name ?? meta.id,
                },
              ],
            }),
          );
        }
      }
    }

    // ── Bootstrap overlay Pin CodeLenses ───────────────────────────────
    // For *.bootstrap.ts files, extractTests returns [] (no test() calls).
    // Each overlay export has a target contract case. The pin stores the
    // TARGET contract file + testId so runPinnedTest dispatches directly
    // to the contract (same as how the shadow TestItem redirect works).
    if (tests.length === 0 && wsFolder) {
      const wsRoot = wsFolder.uri.fsPath;
      const currentPinnedTests = listPinnedTests();
      const dir = path.dirname(document.uri.fsPath);
      const markers = extractBootstrapMarkers(content);

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
          targetContent = content;
          targetFilePath = document.uri.fsPath;
          targetExportName = marker.targetIdent;
        }

        if (!targetContent || !targetFilePath || !targetExportName) continue;
        const contractId = findContractIdInTarget(targetContent, targetExportName);
        if (!contractId) continue;

        const targetTestId = `${contractId}.${marker.caseKey}`;
        const targetUri = vscode.Uri.file(targetFilePath);
        const targetRelPath = vscode.workspace.asRelativePath(targetUri, false);

        if (!isPinnedTest(currentPinnedTests, wsRoot, targetRelPath, targetTestId)) {
          const line = marker.exportLine - 1; // 0-based
          const range = new vscode.Range(line, 0, line, 0);
          lenses.push(
            new vscode.CodeLens(range, {
              title: "$(pin) Pin",
              command: "glubean.pinTest",
              arguments: [
                {
                  uri: targetUri,
                  testId: targetTestId,
                  exportName: targetExportName,
                  label: targetTestId,
                },
              ],
            }),
          );
        }
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
    if (meta.dataSource?.type === "json-import" || meta.dataSource?.type === "json-map") {
      return this.resolveJsonImportKeys(meta.dataSource.path, document);
    }

    // YAML map: read YAML file and extract top-level keys
    if (meta.dataSource?.type === "yaml-map") {
      return this.resolveYamlMapKeys(meta.dataSource.path, document);
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
      const workspaceRoot = workspaceRootFor(filePath);
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
   * Read a YAML file and return its top-level keys.
   */
  private resolveYamlMapKeys(
    yamlPath: string,
    document: vscode.TextDocument,
  ): string[] | null {
    try {
      const filePath = document.uri.fsPath;
      const workspaceRoot = workspaceRootFor(filePath);
      const resolvedPath = resolveDataPath(yamlPath, {
        sourceFilePath: filePath,
        workspaceRoot,
      }).resolvedPath;

      const content = fs.readFileSync(resolvedPath, "utf-8");
      const data = parseYaml(content);

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
   * Resolves the path relative to the project package root (NOT the
   * workspace folder — see workspaceRootFor for the monorepo case).
   */
  private resolveDirMergeKeys(
    dirPath: string,
    document: vscode.TextDocument,
  ): string[] | null {
    try {
      const baseDir = workspaceRootFor(document.uri.fsPath);
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

// =============================================================================
// Contract CodeLens provider
// =============================================================================

export interface ContractCodeLens extends vscode.CodeLensProvider, vscode.Disposable {}

export function createContractCodeLensProvider(
  runCommandId: string,
): ContractCodeLens {
  return new ContractCodeLensProvider(runCommandId);
}

class ContractCodeLensProvider implements ContractCodeLens {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
  private readonly saveListener: vscode.Disposable;

  constructor(private readonly runCommandId: string) {
    this.saveListener = vscode.workspace.onDidSaveTextDocument(() => {
      this._onDidChangeCodeLenses.fire();
    });
  }

  dispose() {
    this.saveListener.dispose();
    this._onDidChangeCodeLenses.dispose();
  }

  provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): vscode.CodeLens[] {
    // `readFile` callback enables `*.bootstrap.ts` lenses to resolve the
    // target case's contractId from the imported `*.contract.ts` sibling.
    // Pure-string fallback when the file isn't readable (e.g. removed
    // mid-edit) — the bootstrap detector then emits a disabled hint lens.
    const items = computeContractLenses(
      document.getText(),
      document.uri.fsPath,
      (absPath) => {
        try {
          return fs.readFileSync(absPath, "utf-8");
        } catch {
          return undefined;
        }
      },
    );
    return items.map((item) => {
      const range = new vscode.Range(item.line, 0, item.line, 0);
      if (item.kind === "disabled") {
        return new vscode.CodeLens(range, { title: item.title, command: "" });
      }
      return new vscode.CodeLens(range, {
        title: item.title,
        command: this.runCommandId,
        arguments: [item.args],
      });
    });
  }
}
