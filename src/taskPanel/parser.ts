import * as fs from "fs";
import * as path from "path";

export interface TaskDef {
  name: string;
  command: string;
  workspaceRoot: string;
}

const GLUBEAN_RUN_RE =
  /(?:^glubean\s+run\b|jsr:@glubean\/cli(?:@[^\s]*)?\s+run\b)/;

export function isGlubeanRunTask(cmd: string): boolean {
  return GLUBEAN_RUN_RE.test(cmd);
}

/**
 * Read `deno.json` or `deno.jsonc` from a workspace root and return every
 * task whose command invokes `glubean run`.
 */
export function parseTasksFromRoot(workspaceRoot: string): TaskDef[] {
  for (const name of ["deno.json", "deno.jsonc"]) {
    const configPath = path.join(workspaceRoot, name);
    if (!fs.existsSync(configPath)) continue;

    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      const json = parseJsonOrJsonc(raw);
      if (!json || typeof json !== "object" || !json.tasks) return [];

      const tasks: TaskDef[] = [];
      for (const [key, value] of Object.entries(json.tasks)) {
        if (typeof value === "string" && isGlubeanRunTask(value)) {
          tasks.push({ name: key, command: value, workspaceRoot });
        }
      }
      return tasks;
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Lenient JSON / JSONC parser — strips single-line and block comments, then
 * strips trailing commas before `}` and `]`. Good enough for `deno.jsonc`
 * without pulling in an extra dependency.
 */
function parseJsonOrJsonc(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    // Probably JSONC — strip comments and trailing commas
  }
  try {
    const stripped = text
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}
