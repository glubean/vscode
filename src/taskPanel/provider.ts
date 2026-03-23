import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { parseTasksFromRoot, type TaskDef } from "./parser";
import { getLastRun, type LastRunState } from "./storage";
import { listPinned, type PinnedFile } from "../pinnedFiles";
import { listPinnedTests, type PinnedTest } from "../pinnedTests";
import { extractTests } from "../parser";

// ── Tree element types ─────────────────────────────────────────────────────

export type TreeElement = SectionHeader | PinnedTestItem | PinnedFileItem | WorkspaceHeader | TaskItem;

export class SectionHeader extends vscode.TreeItem {
  constructor(
    public readonly sectionId: string,
    label: string,
    iconId: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "glubeanSection";
    this.iconPath = new vscode.ThemeIcon(iconId);
  }
}

export class PinnedTestItem extends vscode.TreeItem {
  /** Whether the test definition could be found in the source file */
  public readonly valid: boolean;

  constructor(public readonly pinned: PinnedTest) {
    super(pinned.label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "pinnedTest";
    this.description = pinned.filePath;

    // Check if the source file exists and the test can be found
    const absPath = path.join(pinned.workspaceRoot, pinned.filePath);
    let testLine: number | undefined;
    let fileExists = false;

    try {
      if (fs.existsSync(absPath)) {
        fileExists = true;
        const content = fs.readFileSync(absPath, "utf-8");
        const tests = extractTests(content);
        const match = tests.find((t) => t.id === pinned.testId);
        if (match) {
          testLine = match.line;
        }
      }
    } catch {
      // Ignore read errors
    }

    this.valid = fileExists && testLine !== undefined;

    if (this.valid && testLine !== undefined) {
      this.iconPath = new vscode.ThemeIcon("beaker");
      this.tooltip = `${pinned.filePath}#${pinned.testId}\nClick to open, ▶ to run`;
      // Click opens the file and jumps to the test definition line
      const uri = vscode.Uri.file(absPath);
      this.command = {
        command: "vscode.open",
        title: "Open Test",
        arguments: [
          uri,
          {
            selection: new vscode.Range(testLine - 1, 0, testLine - 1, 0),
          },
        ],
      };
    } else {
      this.iconPath = new vscode.ThemeIcon(
        "warning",
        new vscode.ThemeColor("problemsWarningIcon.foreground"),
      );
      this.tooltip = "Test not found — file may have been modified";
    }
  }
}

export class PinnedFileItem extends vscode.TreeItem {
  constructor(public readonly pinned: PinnedFile) {
    super(pinned.label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "pinnedFile";
    this.iconPath = new vscode.ThemeIcon("file");
    this.description = pinned.filePath;
    this.tooltip = `${pinned.filePath}\nClick to open, ▶ to run`;
    this.command = {
      command: "vscode.open",
      title: "Open File",
      arguments: [vscode.Uri.file(path.join(pinned.workspaceRoot, pinned.filePath))],
    };
  }
}

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
      // Root level: show section headers
      const sections: TreeElement[] = [];

      const pinnedTests = listPinnedTests();
      if (pinnedTests.length > 0) {
        sections.push(new SectionHeader("pinnedTests", "Pinned Tests", "beaker"));
      }

      const pinned = listPinned();
      if (pinned.length > 0) {
        sections.push(new SectionHeader("pinnedFiles", "Pinned Files", "pin"));
      }

      const hasTasks = this.getAllTasks().length > 0;
      if (hasTasks) {
        sections.push(new SectionHeader("tasks", "Tasks", "tasklist"));
      }

      // If only one section and no pinned files/tests, flatten tasks directly
      if (sections.length === 0) return [];
      if (sections.length === 1 && pinned.length === 0 && pinnedTests.length === 0 && hasTasks) {
        // Single root with tasks only — keep flat for backward compatibility
        if (this.roots.length === 1) {
          return this.getTasksByRoot(this.roots[0]);
        }
      }

      return sections;
    }

    if (element instanceof SectionHeader) {
      if (element.sectionId === "pinnedTests") {
        return listPinnedTests().map((p) => new PinnedTestItem(p));
      }
      if (element.sectionId === "pinnedFiles") {
        return listPinned().map((p) => new PinnedFileItem(p));
      }
      if (element.sectionId === "tasks") {
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
  if (status === "running") return "running\u2026";
  if (!lastRun) return "never run";

  const total = lastRun.passed + lastRun.failed + lastRun.skipped;
  if (total === 0) return `no tests found  ${relativeTime(lastRun.timestamp)}`;
  const counts =
    lastRun.failed > 0
      ? `${lastRun.failed}/${total} failed`
      : `${lastRun.passed}/${total} passed`;
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
