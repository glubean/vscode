import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { type TaskItem, type TasksProvider } from "./provider";
import { setLastRun, type LastRunState } from "./storage";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

function getTimeoutMs(): number {
  return vscode.workspace
    .getConfiguration("glubean")
    .get<number>("taskTimeoutMs", DEFAULT_TIMEOUT_MS);
}

function getOpenResultAfterTask(): string {
  return vscode.workspace
    .getConfiguration("glubean")
    .get<string>("openResultAfterTask", "failures");
}

// Grace period between process exit and result file arrival.
// The CLI writes the result file after the process exits, so we wait briefly
// before concluding that no result will arrive.
const RESULT_GRACE_MS = 500;

interface RunningTask {
  item: TaskItem;
  execution: vscode.TaskExecution;
  sendTime: number;
  timeout: ReturnType<typeof setTimeout>;
  resolve: () => void;
  settled: boolean;
}

export class TaskRunner {
  private running = new Map<string, RunningTask>();
  private resultWatcher: vscode.FileSystemWatcher | undefined;

  constructor(private readonly provider: TasksProvider) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────

  activate(subscriptions: vscode.Disposable[]): void {
    this.resultWatcher = vscode.workspace.createFileSystemWatcher(
      "**/.glubean/last-run.result.json",
    );
    this.resultWatcher.onDidChange((uri) => this.onResultChange(uri));
    this.resultWatcher.onDidCreate((uri) => this.onResultChange(uri));
    subscriptions.push(this.resultWatcher);

    // Use the Task API process-end event instead of onDidCloseTerminal.
    // This fires with an exit code and is tied to a specific TaskExecution,
    // making attribution reliable even when multiple terminals are open.
    subscriptions.push(
      vscode.tasks.onDidEndTaskProcess((e) => this.onTaskProcessEnd(e)),
    );
  }

  // ── Public API ─────────────────────────────────────────────────────────

  async runTask(item: TaskItem): Promise<void> {
    // All tasks in a root share the same last-run.result.json file, so only
    // one task per root can run at a time to avoid result misattribution.
    if (this.findRunningForRoot(item.def.workspaceRoot)) return;

    item.status = "running";
    item.applyPresentation();
    this.provider.fireChange(item);

    // Use vscode.Task + ShellExecution so the VS Code runtime handles shell
    // quoting safely — avoids injection via crafted task names (newlines,
    // shell metacharacters, cmd.exe quoting differences, etc.).
    const vsTask = new vscode.Task(
      { type: "glubean", task: item.def.name },
      vscode.TaskScope.Workspace,
      item.def.name,
      "glubean",
      new vscode.ShellExecution("deno", ["task", item.def.name], {
        cwd: item.def.workspaceRoot,
      }),
    );

    const sendTime = Date.now();
    const execution = await vscode.tasks.executeTask(vsTask);

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(
        () => this.onTimeout(runKey(item)),
        getTimeoutMs(),
      );

      this.running.set(runKey(item), {
        item,
        execution,
        sendTime,
        timeout,
        resolve,
        settled: false,
      });
    });
  }

  async runAll(root: string): Promise<void> {
    const tasks = this.provider.getTasksByRoot(root);
    for (const task of tasks) {
      await this.runTask(task);
    }
  }

  async runAllRoots(): Promise<void> {
    for (const task of this.provider.getAllTasks()) {
      await this.runTask(task);
    }
  }

  // ── Event handlers ─────────────────────────────────────────────────────

  private onResultChange(uri: vscode.Uri): void {
    const filePath = uri.fsPath;
    const root = path.resolve(path.dirname(filePath), "..");

    const entry = this.findRunningForRoot(root);
    if (!entry) return;

    this.tryApplyResult(filePath, entry);
  }

  private onTaskProcessEnd(e: vscode.TaskProcessEndEvent): void {
    for (const [key, entry] of this.running) {
      if (entry.execution !== e.execution || entry.settled) continue;

      // Give the file watcher a short grace period before falling back to a
      // manual read. This covers both success (exit 0) and failure paths —
      // the file watcher may not fire reliably in multi-root workspaces.
      setTimeout(() => {
        if (entry.settled) return;

        const resultPath = path.join(
          entry.item.def.workspaceRoot,
          ".glubean",
          "last-run.result.json",
        );
        this.tryApplyResult(resultPath, entry);

        if (entry.settled) return;

        if (e.exitCode !== 0) {
          entry.item.status = "errored";
          entry.item.applyPresentation();
          this.provider.fireChange(entry.item);
          void vscode.window.showWarningMessage(
            `Task '${entry.item.def.name}' finished without results — check terminal output.`,
          );
        } else {
          entry.item.status = "passed";
          entry.item.applyPresentation();
          this.provider.fireChange(entry.item);
        }
        this.settle(key);
      }, RESULT_GRACE_MS);

      break;
    }
  }

  // ── Result handling ───────────────────────────────────────────────────

  private tryApplyResult(filePath: string, entry: RunningTask): void {
    if (entry.settled) return;

    let mtime: number;
    try {
      mtime = fs.statSync(filePath).mtimeMs;
    } catch (e) {
      console.error(`[glubean] Error reading mtime for ${filePath}:`, e);
      return;
    }
    if (mtime < entry.sendTime) return;

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch (e) {
      console.error(`[glubean] Error reading result file ${filePath}:`, e);
      return;
    }

    const parsed = parseResultJson(raw);
    if (!parsed) return;

    const state: LastRunState = {
      timestamp: Date.now(),
      passed: parsed.passed,
      failed: parsed.failed,
      skipped: parsed.skipped,
      durationMs: parsed.durationMs,
    };

    entry.item.lastRun = state;
    entry.item.status = parsed.failed > 0 ? "failed" : "passed";
    entry.item.applyPresentation();

    void setLastRun(
      entry.item.def.workspaceRoot,
      entry.item.def.name,
      state,
    );
    this.provider.fireChange(entry.item);

    const uri = vscode.Uri.file(filePath);
    const openOn = getOpenResultAfterTask();
    if (
      openOn === "always" ||
      (openOn === "failures" && parsed.failed > 0)
    ) {
      void vscode.commands.executeCommand(
        "vscode.openWith",
        uri,
        "glubean.resultViewer",
        vscode.ViewColumn.Beside,
      );
    }

    this.settle(runKey(entry.item));
  }

  private onTimeout(key: string): void {
    const entry = this.running.get(key);
    if (!entry || entry.settled) return;

    entry.item.status = "timeout";
    entry.item.applyPresentation();
    this.provider.fireChange(entry.item);

    void vscode.window.showWarningMessage(
      `Task '${entry.item.def.name}' timed out after ${getTimeoutMs() / 60_000} minutes.`,
    );

    this.settle(key);
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  private findRunningForRoot(root: string): RunningTask | undefined {
    for (const entry of this.running.values()) {
      if (entry.item.def.workspaceRoot === root && !entry.settled) {
        return entry;
      }
    }
    return undefined;
  }

  private settle(key: string): void {
    const entry = this.running.get(key);
    if (!entry || entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timeout);
    entry.resolve();
    this.running.delete(key);
  }
}

// ── Utility ────────────────────────────────────────────────────────────────

function runKey(item: TaskItem): string {
  return `${item.def.workspaceRoot}::${item.def.name}`;
}

interface ParsedResult {
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

function parseResultJson(raw: string): ParsedResult | null {
  try {
    const json = JSON.parse(raw);
    const s = json?.summary;
    if (!s || typeof s.passed !== "number") return null;
    return {
      passed: s.passed,
      failed: s.failed,
      skipped: s.skipped,
      durationMs: s.durationMs,
    };
  } catch (e) {
    console.error("[glubean] Error parsing result JSON:", e);
    return null;
  }
}
