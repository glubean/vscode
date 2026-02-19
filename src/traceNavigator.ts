/**
 * Trace file navigator for Glubean VS Code extension.
 *
 * Manages browsing through `.trace.jsonc` history files.
 * Provides:
 * - `openLatestTrace(workspaceRoot, fileName, testId)` — open the newest trace
 * - `tracePrev()` / `traceNext()` — navigate history
 * - StatusBar item: "Trace 1/5 ◀ ▶" shown when a .trace.jsonc file is active
 *
 * Trace files live at:
 *   `.glubean/traces/{fileName}/{testId}/{timestamp}.trace.jsonc`
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Currently active trace directory (if navigating) */
let currentDir: string | undefined;

/** Sorted list of trace filenames in currentDir (newest first) */
let traceFiles: string[] = [];

/** Index into traceFiles (0 = newest) */
let currentIndex = 0;

/** StatusBar item showing trace position */
let statusBarItem: vscode.StatusBarItem | undefined;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the trace navigator. Call once from extension activate().
 * Returns disposables to push into context.subscriptions.
 */
export function activateTraceNavigator(
  context: vscode.ExtensionContext,
): void {
  // StatusBar item (right side, low priority so it sits near env switcher)
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    98,
  );
  statusBarItem.tooltip = "Glubean: Navigate trace history";
  context.subscriptions.push(statusBarItem);

  // Track active editor changes to show/hide the StatusBar
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(onEditorChanged),
  );

  // Register navigation commands
  context.subscriptions.push(
    vscode.commands.registerCommand("glubean.tracePrev", tracePrev),
    vscode.commands.registerCommand("glubean.traceNext", traceNext),
    vscode.commands.registerCommand("glubean.openTrace", openTraceCommand),
  );

  // Initialize state from current editor (in case it's already a trace file)
  onEditorChanged(vscode.window.activeTextEditor);
}

/**
 * Count the number of trace files for a given test.
 * Returns 0 if the directory doesn't exist.
 */
export function countTraceFiles(
  workspaceRoot: string,
  fileName: string,
  testId: string,
): number {
  const dir = traceDir(workspaceRoot, fileName, testId);
  return listTraceFiles(dir).length;
}

/**
 * Open the latest trace file for a test.
 * Called from CodeLens "Trace (N)" button.
 */
export async function openLatestTrace(
  workspaceRoot: string,
  fileName: string,
  testId: string,
): Promise<void> {
  const dir = traceDir(workspaceRoot, fileName, testId);
  const files = listTraceFiles(dir);

  if (files.length === 0) {
    vscode.window.showInformationMessage(
      `No trace files yet. Run the test first.`,
    );
    return;
  }

  await navigateToTrace(dir, files, 0);
}

/**
 * Navigate to the previous (older) trace file.
 */
export async function tracePrev(): Promise<void> {
  if (!currentDir || traceFiles.length === 0) return;
  const next = Math.min(currentIndex + 1, traceFiles.length - 1);
  if (next !== currentIndex) {
    await navigateToTrace(currentDir, traceFiles, next);
  }
}

/**
 * Navigate to the next (newer) trace file.
 */
export async function traceNext(): Promise<void> {
  if (!currentDir || traceFiles.length === 0) return;
  const next = Math.max(currentIndex - 1, 0);
  if (next !== currentIndex) {
    await navigateToTrace(currentDir, traceFiles, next);
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Build the trace directory path from workspace root, file name, and test ID.
 */
function traceDir(
  workspaceRoot: string,
  fileName: string,
  testId: string,
): string {
  // Strip .ts extension to match CLI convention
  const baseName = fileName.replace(/\.ts$/, "");
  return path.join(workspaceRoot, ".glubean", "traces", baseName, testId);
}

/**
 * List .trace.jsonc files in a directory, sorted newest first.
 * Returns empty array if directory doesn't exist.
 */
function listTraceFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".trace.jsonc"))
      .sort()
      .reverse(); // newest first (filenames are timestamps)
  } catch {
    return [];
  }
}

/**
 * Open a trace file at the given index and update navigator state.
 */
async function navigateToTrace(
  dir: string,
  files: string[],
  index: number,
): Promise<void> {
  currentDir = dir;
  traceFiles = files;
  currentIndex = index;

  const filePath = path.join(dir, files[index]);
  const doc = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(doc, {
    preview: true,
    viewColumn: vscode.ViewColumn.Beside,
  });

  updateStatusBar();
}

/**
 * Handle active editor change — show/hide StatusBar based on file type.
 */
function onEditorChanged(editor: vscode.TextEditor | undefined): void {
  if (!editor) {
    statusBarItem?.hide();
    return;
  }

  const filePath = editor.document.uri.fsPath;
  if (!filePath.endsWith(".trace.jsonc")) {
    statusBarItem?.hide();
    return;
  }

  // Sync navigator state from the file path
  const dir = path.dirname(filePath);
  const fileName = path.basename(filePath);
  const files = listTraceFiles(dir);
  const idx = files.indexOf(fileName);

  if (idx >= 0) {
    currentDir = dir;
    traceFiles = files;
    currentIndex = idx;
    updateStatusBar();
  } else {
    statusBarItem?.hide();
  }
}

/**
 * Update the StatusBar text to reflect current position.
 */
function updateStatusBar(): void {
  if (!statusBarItem || traceFiles.length === 0) return;

  const pos = currentIndex + 1;
  const total = traceFiles.length;

  // Show position and clickable prev/next hints
  statusBarItem.text = `$(history) Trace ${pos}/${total}  $(arrow-left)`;
  // Use a simpler approach: clicking the status bar cycles to the previous trace
  statusBarItem.command = "glubean.tracePrev";
  statusBarItem.tooltip =
    `Glubean Trace ${pos}/${total}\n` +
    `Click for older trace, use keybindings for older/newer\n` +
    `${traceFiles[currentIndex]}`;
  statusBarItem.show();
}

/**
 * Command handler for CodeLens "open trace" — receives args from CodeLens.
 */
async function openTraceCommand(args: {
  workspaceRoot: string;
  fileName: string;
  testId: string;
}): Promise<void> {
  if (!args?.workspaceRoot || !args?.fileName || !args?.testId) return;
  await openLatestTrace(args.workspaceRoot, args.fileName, args.testId);
}
