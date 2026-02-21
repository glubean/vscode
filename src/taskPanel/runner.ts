import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { type TaskItem, type TasksProvider } from "./provider";
import { setLastRun, type LastRunState } from "./storage";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

interface RunningTask {
  item: TaskItem;
  terminal: vscode.Terminal;
  sendTime: number;
  timeout: ReturnType<typeof setTimeout>;
  resolve: () => void;
  settled: boolean;
}

export class TaskRunner {
  private running = new Map<string, RunningTask>();
  private resultWatcher: vscode.FileSystemWatcher | undefined;
  private terminalListener: vscode.Disposable | undefined;

  constructor(private readonly provider: TasksProvider) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────

  activate(subscriptions: vscode.Disposable[]): void {
    this.resultWatcher = vscode.workspace.createFileSystemWatcher(
      "**/.glubean/last-run.result.json",
    );
    this.resultWatcher.onDidChange((uri) => this.onResultChange(uri));
    this.resultWatcher.onDidCreate((uri) => this.onResultChange(uri));
    subscriptions.push(this.resultWatcher);

    this.terminalListener = vscode.window.onDidCloseTerminal((t) =>
      this.onTerminalClose(t),
    );
    subscriptions.push(this.terminalListener);
  }

  // ── Public API ─────────────────────────────────────────────────────────

  async runTask(item: TaskItem): Promise<void> {
    if (this.running.has(runKey(item))) return;

    item.status = "running";
    item.applyPresentation();
    this.provider.fireChange(item);

    const terminal = vscode.window.createTerminal({
      name: `glubean: ${item.def.name}`,
      cwd: item.def.workspaceRoot,
    });

    const sendTime = Date.now();
    terminal.sendText(`deno task ${shellQuote(item.def.name)}`);
    terminal.show(false);

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(
        () => this.onTimeout(runKey(item)),
        DEFAULT_TIMEOUT_MS,
      );

      this.running.set(runKey(item), {
        item,
        terminal,
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

    let mtime: number;
    try {
      mtime = fs.statSync(filePath).mtimeMs;
    } catch {
      return;
    }
    if (mtime < entry.sendTime) return;

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch {
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

    if (parsed.failed > 0) {
      void vscode.commands.executeCommand(
        "vscode.openWith",
        uri,
        "glubean.resultViewer",
        vscode.ViewColumn.Beside,
      );
    }

    this.settle(runKey(entry.item));
  }

  private onTerminalClose(terminal: vscode.Terminal): void {
    for (const [key, entry] of this.running) {
      if (entry.terminal === terminal && !entry.settled) {
        entry.item.status = "errored";
        entry.item.applyPresentation();
        this.provider.fireChange(entry.item);

        void vscode.window
          .showWarningMessage(
            `Task '${entry.item.def.name}' finished without results — check terminal output.`,
            "Show Output",
          )
          .then((action) => {
            if (action === "Show Output") {
              terminal.show();
            }
          });

        this.settle(key);
      }
    }
  }

  private onTimeout(key: string): void {
    const entry = this.running.get(key);
    if (!entry || entry.settled) return;

    entry.item.status = "timeout";
    entry.item.applyPresentation();
    this.provider.fireChange(entry.item);

    void vscode.window.showWarningMessage(
      `Task '${entry.item.def.name}' timed out after ${DEFAULT_TIMEOUT_MS / 60_000} minutes.`,
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

function shellQuote(arg: string): string {
  if (process.platform === "win32") {
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
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
  } catch {
    return null;
  }
}
