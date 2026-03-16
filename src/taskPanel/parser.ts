import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export interface TaskDef {
  name: string;
  command: string;
  workspaceRoot: string;
}

const GLUBEAN_RUN_RE = /\bglubean\s+run\b/;

export function isGlubeanRunTask(cmd: string): boolean {
  return GLUBEAN_RUN_RE.test(cmd);
}

/**
 * Read `package.json` from a workspace root and return every
 * script whose command contains `glubean run` (supports prefixes like `cross-env`, `npx`, etc.).
 */
export function parseTasksFromRoot(workspaceRoot: string): TaskDef[] {
  const configPath = path.join(workspaceRoot, "package.json");
  if (!fs.existsSync(configPath)) return [];

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const json = JSON.parse(raw);
    if (!json || typeof json !== "object" || !json.scripts) return [];

    const tasks: TaskDef[] = [];
    for (const [key, value] of Object.entries(json.scripts)) {
      if (typeof value === "string" && isGlubeanRunTask(value)) {
        tasks.push({ name: key, command: value, workspaceRoot });
      }
    }
    return tasks;
  } catch (e) {
    console.error(`[glubean] Error parsing ${configPath}:`, e);
    void vscode.window.showWarningMessage(
      `Glubean: failed to parse package.json — tasks panel may be incomplete.`,
    );
    return [];
  }
}
