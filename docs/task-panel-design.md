# Glubean Tasks Panel — Design Document

## Background

The VS Code extension currently serves two entry points for running tests:

- **Editor gutter / CodeLens** — developer-centric, runs individual tests in the active file
- **Test Explorer** — developer-centric, hierarchical tree of test files and functions

Both are optimised for developers who write and debug tests. They are the wrong tool for a QA engineer whose workflow is:

> "Run the smoke suite against staging. Did it pass?"

QA engineers are familiar with Postman collections and CI pipelines. They want named, pre-configured run presets they can trigger with a single click — not a file tree of TypeScript functions.

The **Glubean Tasks Panel** fills this gap. It surfaces `glubean run` tasks defined in `deno.json` as a dedicated Activity Bar view, giving QA a one-click interface without requiring any terminal knowledge.

---

## User Stories

**QA engineer**
- I want to see all available test suites at a glance without opening any files
- I want to run a suite with one click and immediately see whether it passed or failed
- I want to see when each suite was last run and what the result was
- I want the result viewer to open automatically after a run

**Developer / team lead**
- I want to define named run presets in `deno.json` once, and have the whole team (including QA) be able to run them
- I want CI and the IDE panel to run exactly the same command

---

## Design Principles

1. **QA does not write commands — QA clicks buttons.** All CLI complexity is hidden.
2. **`deno.json` tasks are the source of truth.** The panel reflects what is defined there, nothing more.
3. **The panel shows results, not details.** Pass/fail counts and timestamps are the language of QA. Flag details (`--env-file`, `--tag`) are noise.
4. **Zero opinion on task content.** The panel runs `deno task <name>` verbatim. It does not rewrite or inject flags.

---

## Task Definition Convention

Tasks in `deno.json` that invoke `glubean run` are surfaced in the panel. Other tasks (`scan`, `validate-metadata`, etc.) are not shown.

```json
{
  "tasks": {
    "test":              "glubean run",
    "test:staging":      "glubean run --env-file .env.staging",
    "test:smoke":        "glubean run -t smoke",
    "test:regression":   "glubean run -t regression",
    "test:auth+smoke":   "glubean run -t auth -t smoke --tag-mode and",
    "test:ci":           "glubean run --ci"
  }
}
```

Detection pattern (matches both installed CLI and legacy `deno run` fallback):

```typescript
function isGlubeanRunTask(cmd: string): boolean {
  return (
    /^glubean\s+run\b/.test(cmd) ||
    /jsr:@glubean\/cli\s+run\b/.test(cmd)
  );
}
```

---

## Panel UI

```
GLUBEAN TASKS                          ↺  ▶
─────────────────────────────────────────────
📁 my-project

  ▶  test               ✓  3/3   2m ago
  ▶  test:staging       ✗  2/3   8m ago
  ▶  test:smoke         ✓  4/4   1h ago
  ▶  test:regression    —  never run
  ▶  test:ci            ✓  6/6   yesterday
```

- Each row is a `TaskItem` in the `TreeDataProvider`
- Status icon: `✓` (all passed), `✗` (failures present), `—` (never run), `⟳` (running)
- Counts and relative timestamp are sourced from `.glubean/last-run.result.json`
- The workspace folder name is shown as a group header in multi-root workspaces
- Toolbar buttons: refresh (re-read `deno.json`) and run all

---

## Data Model

```typescript
interface TaskItem {
  name: string;         // "test:staging"
  command: string;      // "glubean run --env-file .env.staging"
  workspaceRoot: string;
  lastRun?: LastRunState;
}

interface LastRunState {
  timestamp: number;    // Unix ms
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  taskName?: string;    // task name recorded at run time, for matching
}
```

`LastRunState` is persisted in `vscode.ExtensionContext.workspaceState` keyed by `"glubean.taskLastRun.<workspaceRoot>.<taskName>"`.

---

## Execution Model

When the user clicks ▶ on a task row:

1. Mark the item as `running` — show `⟳` icon, disable the run button
2. Spawn: `deno task <name>` in the workspace root via a VS Code `Terminal`

   ```typescript
   const terminal = vscode.window.createTerminal({
     name: `glubean: ${task.name}`,
     cwd: task.workspaceRoot,
   });
   terminal.sendText(`deno task ${task.name}`);
   terminal.show(false); // show panel but don't steal focus
   ```

3. Watch `.glubean/last-run.result.json` for modification (file system watcher)
4. When the file changes, parse it, update `lastRun` state, refresh the tree item
5. If `failed > 0`, open `.glubean/last-run.result.json` directly in `ResultViewerProvider` beside the terminal — it matches `*.result.json`, so the viewer opens automatically with no extra path resolution
6. Mark the item as done — show `✓` or `✗`

Using `terminal.sendText` (rather than spawning a hidden child process) is deliberate:
- The user sees the full CLI output in the terminal, exactly as in CI
- No need to parse stdout; `.glubean/last-run.result.json` is the data channel back to the panel
- Cancellation is natural (user closes the terminal or presses Ctrl+C)

---

## Result File Integration

Since OSS `v0.11.6` (`feat/ci-flag-and-default-results`, PR #23) + `fix/last-run-result-json` (PR #24), every `glubean run` invocation automatically writes `.glubean/last-run.result.json` regardless of flags. The `.result.json` suffix means it is handled by `ResultViewerProvider` natively.

```
.glubean/
  last-run.result.json  ← always written, panel reads this and viewer opens it directly
  traces/               ← trace history (existing)
  traces.json           ← coverage data (existing)
```

**Auto-open result viewer**: after a run completes (detected via the `last-run.result.json` watcher), the panel checks `failed > 0`. If so, it opens `.glubean/last-run.result.json` directly — `ResultViewerProvider` is registered for `*.result.json` and picks it up automatically.

---

## `last-run.result.json` matching

`last-run.result.json` does not record which `deno task` name triggered it — it only records test results. The panel uses a **time-based heuristic**: if `last-run.result.json` is modified within N seconds of `deno task <name>` being sent to the terminal, it is attributed to that task.

### Run All — sequential execution

Running multiple tasks concurrently via a time-based heuristic creates a race condition: if Task A finishes while Task B is already running, the file watcher fires and the panel may attribute Task A's results to Task B.

To avoid this, **Run All executes tasks strictly one at a time**:

```
for each task:
  1. Mark task as running (⟳)
  2. Send `deno task <name>` to terminal
  3. Await a Promise that resolves when the last-run.result.json watcher fires
     (with a reasonable timeout, e.g. 5 minutes)
  4. Attribute the result, update state
  5. Proceed to next task
```

This serialisation guarantees the watcher event that follows a task's terminal command belongs to that task. Parallel execution of tasks is explicitly out of scope for v1.

A more robust long-term solution: add a `taskName` field to `last-run.result.json` via a `--task-name` flag or the `glubean.json` config, removing the need for heuristics. This is an OSS-side improvement to track separately.

---

## File Watchers

| Watch target | Trigger | Action |
|---|---|---|
| `**/deno.json` | create / change | Re-read tasks, rebuild tree |
| `**/.glubean/last-run.result.json` | change | Update `lastRun` state, refresh tree, conditionally open result viewer |
| Workspace folders | add / remove | Rescan for `deno.json` files |

All watchers use `vscode.workspace.createFileSystemWatcher`. They are disposed on extension deactivation.

---

## File Structure

```
src/
  taskPanel/
    provider.ts     TreeDataProvider — reads deno.json, builds tree, handles refresh
    runner.ts       Executes deno task, watches last-run.result.json, updates state
    parser.ts       Parses task command string → structured metadata
    storage.ts      Persists/loads lastRun state via workspaceState
  extension.ts      Registers viewsContainers, views, wires up provider
package.json        viewsContainers + views contributions
```

Estimated implementation size: ~450 lines total. No webview. No new npm dependencies.

---

## `package.json` Contributions

> **Note on `when` clause syntax**: VS Code when-clause context keys (`view`, `viewItem`, etc.) use unquoted identifiers — `view == glubean.tasksView` is the correct and documented syntax. See [VS Code When Clause Contexts](https://code.visualstudio.com/api/references/when-clause-contexts).

```json
{
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        {
          "id": "glubeanTasks",
          "title": "Glubean",
          "icon": "icon.png"
        }
      ]
    },
    "views": {
      "glubeanTasks": [
        {
          "id": "glubean.tasksView",
          "name": "Tasks",
          "when": "workspaceContains:**/deno.json"
        }
      ]
    },
    "commands": [
      {
        "command": "glubean.tasks.run",
        "title": "Run",
        "icon": "$(play)"
      },
      {
        "command": "glubean.tasks.runAll",
        "title": "Run All Tasks",
        "icon": "$(run-all)"
      },
      {
        "command": "glubean.tasks.refresh",
        "title": "Refresh",
        "icon": "$(refresh)"
      }
    ],
    "menus": {
      "view/title": [
        {
          "command": "glubean.tasks.runAll",
          "when": "view == glubean.tasksView",
          "group": "navigation"
        },
        {
          "command": "glubean.tasks.refresh",
          "when": "view == glubean.tasksView",
          "group": "navigation"
        }
      ],
      "view/item/context": [
        {
          "command": "glubean.tasks.run",
          "when": "view == glubean.tasksView && viewItem == glubeanTask",
          "group": "inline"
        }
      ]
    }
  }
}
```

---

## Relationship to Existing Features

| Feature | Audience | Relationship |
|---|---|---|
| Editor gutter ▶ / CodeLens | Developer | Independent — no overlap |
| VS Code Test Explorer | Developer | Independent — no overlap |
| **Glubean Tasks Panel** | **QA engineer** | New entry point, reads same `last-run.result.json` as `openLastResult` command |
| Result Viewer (`ResultViewerProvider`) | QA / Developer | Reused — panel triggers it automatically after a run |
| Trace Viewer (`TraceViewerProvider`) | Developer | Independent — QA may use it if they click into individual failures |

---

## Out of Scope (v1)

- Watching a running terminal for live pass/fail updates (requires process spawning, not `terminal.sendText`)
- "Run All" executing tasks in parallel
- Task editing UI (users edit `deno.json` directly)
- Custom task ordering (shown in `deno.json` definition order)
- Tag-based run profiles in Test Explorer (separate backlog item)
