import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export interface TraceModuleDeps {
  workspaceRootFor(filePath: string): string;
}

/**
 * Find and open the latest .trace.jsonc file for a given test file.
 *
 * Traces live at `.glubean/traces/{fileName}/{dirId}/{filename}.trace.jsonc`.
 * For simple/each tests: dirId = testId, filename = `{timestamp}`.
 * For pick tests: dirId = groupId (template), filename = `{timestamp}--{testId}`.
 *
 * When `testId` is provided, looks in that specific subdirectory.
 * When omitted (e.g. "run all" or pick/CodeLens without a known ID),
 * scans all test subdirectories and opens the globally newest trace.
 */
export async function openLatestTrace(
  filePath: string,
  testId: string | undefined,
  deps: TraceModuleDeps,
): Promise<void> {
  const cwd = deps.workspaceRootFor(filePath);

  const baseName = path.basename(filePath).replace(/\.ts$/, "");
  const fileTracesDir = path.join(cwd, ".glubean", "traces", baseName);

  try {
    let latestPath: string | undefined;

    if (testId) {
      // Look in the specific test subdirectory
      const testDir = path.join(fileTracesDir, testId);
      const entries = fs
        .readdirSync(testDir)
        .filter((f) => f.endsWith(".trace.jsonc"));
      if (entries.length === 0) return;
      entries.sort().reverse();
      latestPath = path.join(testDir, entries[0]);
    } else {
      // Scan all test subdirectories for the newest trace
      const subdirs = fs
        .readdirSync(fileTracesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory());

      let newest: { file: string; dir: string } | undefined;
      for (const sub of subdirs) {
        const subPath = path.join(fileTracesDir, sub.name);
        const traces = fs
          .readdirSync(subPath)
          .filter((f) => f.endsWith(".trace.jsonc"));
        if (traces.length === 0) continue;
        traces.sort().reverse();
        if (!newest || traces[0] > newest.file) {
          newest = { file: traces[0], dir: subPath };
        }
      }
      if (!newest) return;
      latestPath = path.join(newest.dir, newest.file);
    }

    if (!latestPath) return;

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(latestPath));
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: true,
      preserveFocus: true, // keep focus on the test file
    });
  } catch {
    // Trace dir doesn't exist yet or read failed — silently skip
  }
}

/**
 * Open a VSCode diff view comparing the two most recent trace files
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

  const baseName = path
    .basename(resolved)
    .replace(/\.ts$/, "")
    .replace(/\.trace\.jsonc$/, ""); // allow calling from an open trace file

  const fileTracesDir = path.join(cwd, ".glubean", "traces", baseName);

  try {
    // If the resolved file is itself a trace file, its parent dir is the
    // per-test trace directory — diff within that directory.
    if (resolved.endsWith(".trace.jsonc")) {
      const traceDir = path.dirname(resolved);
      return await diffInDir(traceDir, baseName);
    }

    // Otherwise scan all test subdirectories and collect every trace with
    // its full path, then pick the two newest globally.
    const subdirs = fs
      .readdirSync(fileTracesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());

    const allTraces: { name: string; fullPath: string }[] = [];
    for (const sub of subdirs) {
      const subPath = path.join(fileTracesDir, sub.name);
      const traces = fs
        .readdirSync(subPath)
        .filter((f) => f.endsWith(".trace.jsonc"));
      for (const t of traces) {
        allTraces.push({ name: t, fullPath: path.join(subPath, t) });
      }
    }

    if (allTraces.length < 2) {
      return false;
    }

    allTraces.sort((a, b) => b.name.localeCompare(a.name));
    const newestUri = vscode.Uri.file(allTraces[0].fullPath);
    const previousUri = vscode.Uri.file(allTraces[1].fullPath);

    const diffLabel = buildDiffLabel(
      baseName,
      allTraces[1].name,
      allTraces[0].name,
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
 * Diff the two most recent traces within a single directory.
 */
async function diffInDir(dir: string, label: string): Promise<boolean> {
  const entries = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".trace.jsonc"));
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
 * Build a human-readable diff label. For pick traces with variant-encoded
 * filenames (e.g. `20260220T1200--search-by-name.trace.jsonc`), shows the
 * variant names. Falls back to "previous / latest" for plain timestamps.
 */
function buildDiffLabel(
  base: string,
  olderFile: string,
  newerFile: string,
): string {
  const extractVariant = (f: string): string | undefined => {
    const stem = f.replace(/\.trace\.jsonc$/, "");
    const idx = stem.indexOf("--");
    return idx >= 0 ? stem.slice(idx + 2) : undefined;
  };
  const left = extractVariant(olderFile);
  const right = extractVariant(newerFile);
  if (left && right) {
    return left === right
      ? `${base} (${left}): previous ↔ latest`
      : `${base}: ${left} ↔ ${right}`;
  }
  return `${base}: previous ↔ latest`;
}
