import * as vscode from "vscode";
import { parseTasksFromRoot, type TaskDef } from "./parser";
import { getLastRun, type LastRunState } from "./storage";

// ── Tree element types ─────────────────────────────────────────────────────

export type TreeElement = WorkspaceHeader | TaskItem;

export class WorkspaceHeader extends vscode.TreeItem {
  constructor(public readonly rootPath: string, label: string) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "glubeanWorkspace";
    this.iconPath = new vscode.ThemeIcon("root-folder");
  }
}

export type TaskStatus =
  | "idle"
  | "running"
  | "passed"
  | "failed"
  | "errored"
  | "timeout"
  | "cancelled";

export class TaskItem extends vscode.TreeItem {
  public status: TaskStatus = "idle";
  public lastRun?: LastRunState;

  constructor(public readonly def: TaskDef) {
    super(def.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "glubeanTask";

    const saved = getLastRun(def.workspaceRoot, def.name);
    if (saved) {
      this.lastRun = saved;
      this.status = saved.failed > 0 ? "failed" : "passed";
    }

    this.applyPresentation();
  }

  applyPresentation(): void {
    const { status, lastRun } = this;
    this.iconPath = iconFor(status);
    this.description = descriptionFor(status, lastRun);
    this.tooltip = tooltipFor(this.def, status, lastRun);
  }
}

// ── Provider ───────────────────────────────────────────────────────────────

export class TasksProvider implements vscode.TreeDataProvider<TreeElement> {
  private _onDidChange = new vscode.EventEmitter<TreeElement | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private roots: string[] = [];
  private tasksByRoot = new Map<string, TaskItem[]>();

  refresh(): void {
    this.tasksByRoot.clear();
    this.roots = (vscode.workspace.workspaceFolders ?? []).map(
      (f) => f.uri.fsPath,
    );
    for (const root of this.roots) {
      const defs = parseTasksFromRoot(root);
      this.tasksByRoot.set(
        root,
        defs.map((d) => new TaskItem(d)),
      );
    }
    this._onDidChange.fire(undefined);
  }

  getAllTasks(): TaskItem[] {
    return [...this.tasksByRoot.values()].flat();
  }

  getTasksByRoot(root: string): TaskItem[] {
    return this.tasksByRoot.get(root) ?? [];
  }

  fireChange(item?: TreeElement): void {
    this._onDidChange.fire(item);
  }

  // ── TreeDataProvider ───────────────────────────────────────────────────

  getTreeItem(element: TreeElement): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeElement): TreeElement[] {
    if (!element) {
      if (this.roots.length === 0) return [];
      if (this.roots.length === 1) {
        return this.getTasksByRoot(this.roots[0]);
      }
      return this.roots
        .filter((r) => (this.tasksByRoot.get(r)?.length ?? 0) > 0)
        .map((r) => {
          const folder = vscode.workspace.workspaceFolders?.find(
            (f) => f.uri.fsPath === r,
          );
          return new WorkspaceHeader(r, folder?.name ?? r);
        });
    }
    if (element instanceof WorkspaceHeader) {
      return this.getTasksByRoot(element.rootPath);
    }
    return [];
  }
}

// ── Presentation helpers ───────────────────────────────────────────────────

function iconFor(status: TaskStatus): vscode.ThemeIcon {
  switch (status) {
    case "running":
      return new vscode.ThemeIcon(
        "sync~spin",
        new vscode.ThemeColor("charts.yellow"),
      );
    case "passed":
      return new vscode.ThemeIcon(
        "pass",
        new vscode.ThemeColor("testing.iconPassed"),
      );
    case "failed":
      return new vscode.ThemeIcon(
        "error",
        new vscode.ThemeColor("testing.iconFailed"),
      );
    case "errored":
    case "timeout":
      return new vscode.ThemeIcon(
        "warning",
        new vscode.ThemeColor("testing.iconErrored"),
      );
    case "cancelled":
      return new vscode.ThemeIcon("circle-slash");
    default:
      return new vscode.ThemeIcon("circle-outline");
  }
}

function descriptionFor(
  status: TaskStatus,
  lastRun?: LastRunState,
): string {
  if (status === "running") return "running…";
  if (!lastRun) return "never run";

  const total = lastRun.passed + lastRun.failed + lastRun.skipped;
  const counts =
    lastRun.failed > 0
      ? `${lastRun.passed}/${total}`
      : `${lastRun.passed}/${total}`;
  return `${counts}  ${relativeTime(lastRun.timestamp)}`;
}

function tooltipFor(
  def: TaskDef,
  status: TaskStatus,
  lastRun?: LastRunState,
): string {
  const lines = [`Task: ${def.name}`, `Command: ${def.command}`];
  if (status === "running") lines.push("Status: running");
  if (lastRun) {
    lines.push(
      `Last run: ${new Date(lastRun.timestamp).toLocaleString()}`,
      `Passed: ${lastRun.passed}  Failed: ${lastRun.failed}  Skipped: ${lastRun.skipped}`,
      `Duration: ${(lastRun.durationMs / 1000).toFixed(1)}s`,
    );
  }
  return lines.join("\n");
}

function relativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}
