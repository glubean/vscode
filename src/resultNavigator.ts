/**
 * Result file navigator for Glubean VS Code extension.
 *
 * Manages browsing through `.result.json` history files.
 * Provides:
 * - `openLatestResult(workspaceRoot, fileName, testId)` — open the newest result
 * - `resultPrev()` / `resultNext()` — navigate history
 * - Webview buttons that trigger resultPrev/resultNext commands
 *
 * Result files live at:
 *   `.glubean/results/{fileName}/{normalizedTestId}/{timestamp}[pickKey].result.json`
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { resultHistoryDir } from "./resultHistory";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Currently active result directory (if navigating) */
let currentDir: string | undefined;

/** Sorted list of result filenames in currentDir (newest first) */
let resultFiles: string[] = [];

/** Index into resultFiles (0 = newest) */
let currentIndex = 0;


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the result navigator. Call once from extension activate().
 */
export function activateResultNavigator(
  context: vscode.ExtensionContext,
): void {
  // Track active editor changes to sync navigator state
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(onEditorChanged),
  );

  // Register navigation commands
  context.subscriptions.push(
    vscode.commands.registerCommand("glubean.resultPrev", resultPrev),
    vscode.commands.registerCommand("glubean.resultNext", resultNext),
    vscode.commands.registerCommand("glubean.openResult", openResultCommand),
  );

  // Initialize state from current editor (in case it's already a result file)
  onEditorChanged(vscode.window.activeTextEditor);
}

/**
 * Count the number of result files for a given test.
 * Returns 0 if the directory doesn't exist.
 */
export function countResultFiles(
  workspaceRoot: string,
  fileName: string,
  testId: string,
): number {
  const dir = resultHistoryDir(workspaceRoot, fileName, testId);
  return listResultFiles(dir).length;
}

/**
 * Open the latest result file for a test.
 * Called from CodeLens "Results (N)" button.
 */
export async function openLatestResult(
  workspaceRoot: string,
  fileName: string,
  testId: string,
): Promise<void> {
  const dir = resultHistoryDir(workspaceRoot, fileName, testId);
  const files = listResultFiles(dir);

  if (files.length === 0) {
    vscode.window.showInformationMessage(
      `No result files yet. Run the test first.`,
    );
    return;
  }

  await navigateToResult(dir, files, 0, true);
}

/**
 * Navigate to the previous (older) result file.
 */
export async function resultPrev(): Promise<void> {
  ensureStateFromActiveEditor();
  if (!currentDir || resultFiles.length === 0) return;
  if (currentIndex >= resultFiles.length - 1) {
    void vscode.window.showInformationMessage("No older results.");
    return;
  }
  await navigateToResult(currentDir, resultFiles, currentIndex + 1);
}

/**
 * Navigate to the next (newer) result file.
 */
export async function resultNext(): Promise<void> {
  ensureStateFromActiveEditor();
  if (!currentDir || resultFiles.length === 0) return;
  if (currentIndex <= 0) {
    void vscode.window.showInformationMessage("Already at the newest result.");
    return;
  }
  await navigateToResult(currentDir, resultFiles, currentIndex - 1);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * If navigator state is empty, try to populate it from the active tab.
 * Custom text editors (webviews) don't fire onDidChangeActiveTextEditor,
 * so we also check vscode.window.tabGroups for an active .result.json tab.
 */
function ensureStateFromActiveEditor(): void {
  if (currentDir && resultFiles.length > 0) return;

  // Try standard active text editor first
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const fp = editor.document.uri.fsPath;
    if (fp.endsWith(".result.json")) {
      syncFromPath(fp);
      return;
    }
  }

  // Fall back to active tab URI (covers custom editors / webviews)
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (activeTab?.input && typeof (activeTab.input as { uri?: unknown }).uri === "object") {
    const uri = (activeTab.input as { uri: vscode.Uri }).uri;
    if (uri.fsPath.endsWith(".result.json")) {
      syncFromPath(uri.fsPath);
    }
  }
}

function syncFromPath(fsPath: string): void {
  const dir = path.dirname(fsPath);
  const fileName = path.basename(fsPath);
  const files = listResultFiles(dir);
  const idx = files.indexOf(fileName);
  if (idx >= 0) {
    currentDir = dir;
    resultFiles = files;
    currentIndex = idx;
  }
}

/**
 * List .result.json files in a directory, sorted newest first.
 * Returns empty array if directory doesn't exist.
 */
function listResultFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".result.json"))
      .sort()
      .reverse(); // newest first (filenames are timestamps)
  } catch {
    return [];
  }
}

/**
 * Open a result file at the given index and update navigator state.
 * @param beside — true to open in a column beside the current editor (initial open from CodeLens),
 *                 false to replace the current tab (prev/next navigation).
 */
async function navigateToResult(
  dir: string,
  files: string[],
  index: number,
  beside = false,
): Promise<void> {
  currentDir = dir;
  resultFiles = files;
  currentIndex = index;

  const filePath = path.join(dir, files[index]);
  await vscode.commands.executeCommand(
    "vscode.openWith",
    vscode.Uri.file(filePath),
    "glubean.resultViewer",
    {
      viewColumn: beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
      preview: true,
    },
  );
}

/**
 * Handle active editor change — sync navigator state from file path.
 */
function onEditorChanged(editor: vscode.TextEditor | undefined): void {
  if (!editor) return;

  const filePath = editor.document.uri.fsPath;
  if (!filePath.endsWith(".result.json")) return;

  const dir = path.dirname(filePath);
  const fileName = path.basename(filePath);
  const files = listResultFiles(dir);
  const idx = files.indexOf(fileName);

  if (idx >= 0) {
    currentDir = dir;
    resultFiles = files;
    currentIndex = idx;
  }
}

/**
 * Command handler for CodeLens "open result" — receives args from CodeLens.
 */
async function openResultCommand(args: {
  workspaceRoot: string;
  fileName: string;
  testId: string;
}): Promise<void> {
  if (!args?.workspaceRoot || !args?.fileName || !args?.testId) return;
  await openLatestResult(args.workspaceRoot, args.fileName, args.testId);
}
