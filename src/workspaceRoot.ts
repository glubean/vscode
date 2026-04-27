/**
 * Workspace / project root resolution shared between TestController and
 * CodeLens providers.
 *
 * "Workspace root" in VSCode means the folder the user opened. "Project
 * root" in Glubean's sense means the package dir — the nearest ancestor
 * with a `package.json`. In a monorepo cookbook layout
 * (`cookbook/{test-after,contract-first}/`) the user typically opens
 * `cookbook/` as the workspace, but data files (`data/...`), .env, and
 * `node_modules/` live inside the package dir. Resolving relative paths
 * against the workspace folder produces wrong absolute paths in that case.
 *
 * Both `executeTest()` (testController) and the data-loader / pick-keys
 * CodeLens (codeLensProvider) need the package root. This module is the
 * single source of truth.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

/**
 * Resolve the project root for a given file path.
 *
 * Walks up from the file looking for the nearest `package.json`, bounded
 * by the VSCode workspace folder root. This correctly resolves to the
 * workspace *package* dir in monorepos (e.g. `cookbook/test-after/`)
 * rather than the workspace root (`cookbook/`).
 *
 * Falls back to:
 * - the VS Code workspace folder if no `package.json` ancestor exists
 *   inside it (e.g. an unconfigured workspace)
 * - the file's own directory if VSCode reports no workspace folder
 *   (zero-project / scratch mode — don't walk up to avoid grabbing an
 *   unrelated `package.json` from somewhere else on disk).
 */
export function workspaceRootFor(filePath: string): string {
  const fileUri = vscode.Uri.file(filePath);
  const wsFolder = vscode.workspace.getWorkspaceFolder(fileUri);

  if (!wsFolder) {
    return path.dirname(filePath);
  }

  const ceiling = wsFolder.uri.fsPath;
  let dir = path.dirname(filePath);
  while (dir.length >= ceiling.length) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return wsFolder.uri.fsPath;
}
