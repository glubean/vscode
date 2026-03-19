import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
  extractHistoryLabel,
  historyBaseName,
  resultHistoryDir,
  resultHistoryRoot,
} from "../resultHistory";

export interface TraceModuleDeps {
  workspaceRootFor(filePath: string): string;
}

/**
 * Find and open the latest .result.json file for a given test file.
 *
 * Results live at `.glubean/results/{fileName}/{normalizedTestId}/{filename}.result.json`.
 * For simple/each tests: filename = `{timestamp}`.
 * For pick tests: filename = `{timestamp}[{pickKey}]`.
 *
 * When `testId` is provided, looks in that specific subdirectory.
 * When omitted (e.g. "run all" or pick/CodeLens without a known ID),
 * scans all test subdirectories and opens the globally newest result.
 */
export async function openLatestResult(
  filePath: string,
  testId: string | undefined,
  deps: TraceModuleDeps,
): Promise<void> {
  const cwd = deps.workspaceRootFor(filePath);

  const fileResultsDir = resultHistoryRoot(cwd, filePath);

  try {
    let latestPath: string | undefined;

    if (testId) {
      // Look in the specific test subdirectory
      const testDir = resultHistoryDir(cwd, filePath, testId);
      const entries = fs
        .readdirSync(testDir)
        .filter((f) => f.endsWith(".result.json"));
      if (entries.length === 0) return;
      entries.sort().reverse();
      latestPath = path.join(testDir, entries[0]);
    } else {
      // Scan all test subdirectories for the newest result
      const subdirs = fs
        .readdirSync(fileResultsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory());

      let newest: { file: string; dir: string } | undefined;
      for (const sub of subdirs) {
        const subPath = path.join(fileResultsDir, sub.name);
        const results = fs
          .readdirSync(subPath)
          .filter((f) => f.endsWith(".result.json"));
        if (results.length === 0) continue;
        results.sort().reverse();
        if (!newest || results[0] > newest.file) {
          newest = { file: results[0], dir: subPath };
        }
      }
      if (!newest) return;
      latestPath = path.join(newest.dir, newest.file);
    }

    if (!latestPath) return;

    await vscode.commands.executeCommand(
      "vscode.openWith",
      vscode.Uri.file(latestPath),
      "glubean.resultViewer",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: true },
    );
  } catch {
    // Result dir doesn't exist yet or read failed — silently skip
  }
}

/**
 * Open a VSCode diff view comparing the two most recent result files
 * for the given test file. If called without a filePath,
 * tries to infer from the active editor.
 */
export async function diffWithPrevious(
  filePath: string | undefined,
  deps: TraceModuleDeps,
): Promise<boolean> {
  // Resolve file path from argument, active editor
  const resolved = filePath ?? vscode.window.activeTextEditor?.document.fileName;

  if (!resolved) {
    return false;
  }

  const cwd = deps.workspaceRootFor(resolved);

  const baseName = historyBaseName(resolved);

  const fileResultsDir = path.join(cwd, ".glubean", "results", baseName);

  try {
    // If the resolved file is itself a result file, its parent dir is the
    // per-test result directory — diff within that directory.
    if (resolved.endsWith(".result.json")) {
      const resultDir = path.dirname(resolved);
      return await diffInDir(resultDir, baseName);
    }

    // Otherwise scan all test subdirectories and collect every result with
    // its full path, then pick the two newest globally.
    const subdirs = fs
      .readdirSync(fileResultsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());

    const allResults: { name: string; fullPath: string }[] = [];
    for (const sub of subdirs) {
      const subPath = path.join(fileResultsDir, sub.name);
      const results = fs
        .readdirSync(subPath)
        .filter((f) => f.endsWith(".result.json"));
      for (const t of results) {
        allResults.push({ name: t, fullPath: path.join(subPath, t) });
      }
    }

    if (allResults.length < 2) {
      return false;
    }

    allResults.sort((a, b) => b.name.localeCompare(a.name));
    const newestUri = vscode.Uri.file(allResults[0].fullPath);
    const previousUri = vscode.Uri.file(allResults[1].fullPath);

    const diffLabel = buildDiffLabel(
      baseName,
      allResults[1].name,
      allResults[0].name,
    );
    await vscode.commands.executeCommand(
      "vscode.diff",
      previousUri,
      newestUri,
      diffLabel,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Diff the two most recent results within a single directory.
 */
async function diffInDir(dir: string, label: string): Promise<boolean> {
  const entries = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".result.json"));
  if (entries.length < 2) return false;

  entries.sort().reverse();
  const newestUri = vscode.Uri.file(path.join(dir, entries[0]));
  const previousUri = vscode.Uri.file(path.join(dir, entries[1]));

  const diffLabel = buildDiffLabel(label, entries[1], entries[0]);
  await vscode.commands.executeCommand(
    "vscode.diff",
    previousUri,
    newestUri,
    diffLabel,
  );
  return true;
}

/**
 * Build a human-readable diff label. For pick results with readable suffixes
 * (e.g. `20260220T1200[by-name].result.json`), shows the suffix. Falls back
 * to "previous / latest" for plain timestamps.
 */
function buildDiffLabel(
  base: string,
  olderFile: string,
  newerFile: string,
): string {
  const left = extractHistoryLabel(olderFile);
  const right = extractHistoryLabel(newerFile);
  if (left && right) {
    return left === right
      ? `${base} (${left}): previous ↔ latest`
      : `${base}: ${left} ↔ ${right}`;
  }
  return `${base}: previous ↔ latest`;
}
