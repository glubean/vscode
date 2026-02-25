/**
 * Trace file navigator for Glubean VS Code extension.
 *
 * Manages browsing through `.trace.jsonc` history files.
 * Provides:
 * - `openLatestTrace(workspaceRoot, fileName, testId)` — open the newest trace
 * - `tracePrev()` / `traceNext()` — navigate history
 * - Webview ‹ › buttons that trigger tracePrev/traceNext commands
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


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the trace navigator. Call once from extension activate().
 */
export function activateTraceNavigator(
  context: vscode.ExtensionContext,
): void {
  // Track active editor changes to sync navigator state
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

  await navigateToTrace(dir, files, 0, true);
}

/**
 * Navigate to the previous (older) trace file.
 */
export async function tracePrev(): Promise<void> {
  ensureStateFromActiveEditor();
  if (!currentDir || traceFiles.length === 0) return;
  if (currentIndex >= traceFiles.length - 1) {
    void vscode.window.showInformationMessage("No older traces.");
    return;
  }
  await navigateToTrace(currentDir, traceFiles, currentIndex + 1);
}

/**
 * Navigate to the next (newer) trace file.
 */
export async function traceNext(): Promise<void> {
  ensureStateFromActiveEditor();
  if (!currentDir || traceFiles.length === 0) return;
  if (currentIndex <= 0) {
    void vscode.window.showInformationMessage("Already at the newest trace.");
    return;
  }
  await navigateToTrace(currentDir, traceFiles, currentIndex - 1);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * If navigator state is empty, try to populate it from the active tab.
 * Custom text editors (webviews) don't fire onDidChangeActiveTextEditor,
 * so we also check vscode.window.tabGroups for an active .trace.jsonc tab.
 */
function ensureStateFromActiveEditor(): void {
  if (currentDir && traceFiles.length > 0) return;

  // Try standard active text editor first
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const fp = editor.document.uri.fsPath;
    if (fp.endsWith(".trace.jsonc")) {
      syncFromPath(fp);
      return;
    }
  }

  // Fall back to active tab URI (covers custom editors / webviews)
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (activeTab?.input && typeof (activeTab.input as { uri?: unknown }).uri === "object") {
    const uri = (activeTab.input as { uri: vscode.Uri }).uri;
    if (uri.fsPath.endsWith(".trace.jsonc")) {
      syncFromPath(uri.fsPath);
    }
  }
}

function syncFromPath(fsPath: string): void {
  const dir = path.dirname(fsPath);
  const fileName = path.basename(fsPath);
  const files = listTraceFiles(dir);
  const idx = files.indexOf(fileName);
  if (idx >= 0) {
    currentDir = dir;
    traceFiles = files;
    currentIndex = idx;
  }
}

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
 * @param beside — true to open in a column beside the current editor (initial open from CodeLens),
 *                 false to replace the current tab (prev/next navigation).
 */
async function navigateToTrace(
  dir: string,
  files: string[],
  index: number,
  beside = false,
): Promise<void> {
  currentDir = dir;
  traceFiles = files;
  currentIndex = index;

  const filePath = path.join(dir, files[index]);
  await vscode.commands.executeCommand(
    "vscode.openWith",
    vscode.Uri.file(filePath),
    "glubean.traceViewer",
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
  if (!filePath.endsWith(".trace.jsonc")) return;

  const dir = path.dirname(filePath);
  const fileName = path.basename(filePath);
  const files = listTraceFiles(dir);
  const idx = files.indexOf(fileName);

  if (idx >= 0) {
    currentDir = dir;
    traceFiles = files;
    currentIndex = idx;
  }
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
