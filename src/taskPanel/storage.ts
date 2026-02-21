import * as vscode from "vscode";

export interface LastRunState {
  timestamp: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

const KEY_PREFIX = "glubean.taskLastRun";

function stateKey(root: string, taskName: string): string {
  return `${KEY_PREFIX}.${root}.${taskName}`;
}

let workspaceState: vscode.Memento | undefined;

export function initStorage(state: vscode.Memento): void {
  workspaceState = state;
}

export function getLastRun(
  root: string,
  taskName: string,
): LastRunState | undefined {
  return workspaceState?.get<LastRunState>(stateKey(root, taskName));
}

export async function setLastRun(
  root: string,
  taskName: string,
  state: LastRunState,
): Promise<void> {
  await workspaceState?.update(stateKey(root, taskName), state);
}
