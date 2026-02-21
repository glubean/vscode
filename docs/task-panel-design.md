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
- Counts and relative timestamp are sourced from `.glubean/last-run.json`
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

3. Watch `.glubean/last-run.json` for modification (file system watcher)
4. When the file changes, parse it, update `lastRun` state, refresh the tree item
5. If `last-run.json` indicates failures → open `ResultViewerProvider` automatically beside the terminal
6. Mark the item as done — show `✓` or `✗`

Using `terminal.sendText` (rather than spawning a hidden child process) is deliberate:
- The user sees the full CLI output in the terminal, exactly as in CI
- No need to parse stdout; `.glubean/last-run.json` is the data channel back to the panel
- Cancellation is natural (user closes the terminal or presses Ctrl+C)

---

## Result File Integration

Since OSS `v0.11.6` (`feat/ci-flag-and-default-results`, merged PR #23), every `glubean run` invocation automatically writes `.glubean/last-run.json` regardless of flags. This is the panel's data channel.

```
.glubean/
  last-run.json       ← always written, panel reads this
  traces/             ← trace history (existing)
  traces.json         ← coverage data (existing)
```

**Auto-open result viewer**: after a run completes (detected via the `last-run.json` watcher), the panel checks `failed > 0`. If so, it opens the file in `ResultViewerProvider` beside the terminal so QA sees the failure summary without any extra clicks.

---

## `last-run.json` matching

`last-run.json` does not record which `deno task` name triggered it — it only records test results. The panel uses a **time-based heuristic**: if `last-run.json` is modified within N seconds of `deno task <name>` being sent to the terminal, it is attributed to that task.

A more robust solution (future): add a `taskName` field to `last-run.json` via a `--task-name` flag or the `glubean.json` config. This is an OSS-side improvement to track separately.

---

## File Watchers

| Watch target | Trigger | Action |
|---|---|---|
| `**/deno.json` | create / change | Re-read tasks, rebuild tree |
| `**/.glubean/last-run.json` | change | Update `lastRun` state, refresh tree, conditionally open result viewer |
| Workspace folders | add / remove | Rescan for `deno.json` files |

All watchers use `vscode.workspace.createFileSystemWatcher`. They are disposed on extension deactivation.

---

## File Structure

```
src/
  taskPanel/
    provider.ts     TreeDataProvider — reads deno.json, builds tree, handles refresh
    runner.ts       Executes deno task, watches last-run.json, updates state
    parser.ts       Parses task command string → structured metadata
    storage.ts      Persists/loads lastRun state via workspaceState
  extension.ts      Registers viewsContainers, views, wires up provider
package.json        viewsContainers + views contributions
```

Estimated implementation size: ~450 lines total. No webview. No new npm dependencies.

---

## `package.json` Contributions

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
| **Glubean Tasks Panel** | **QA engineer** | New entry point, reads same `last-run.json` as `openLastResult` command |
| Result Viewer (`ResultViewerProvider`) | QA / Developer | Reused — panel triggers it automatically after a run |
| Trace Viewer (`TraceViewerProvider`) | Developer | Independent — QA may use it if they click into individual failures |

---

## Out of Scope (v1)

- Watching a running terminal for live pass/fail updates (requires process spawning, not `terminal.sendText`)
- "Run All" executing tasks in parallel
- Task editing UI (users edit `deno.json` directly)
- Custom task ordering (shown in `deno.json` definition order)
- Tag-based run profiles in Test Explorer (separate backlog item)
