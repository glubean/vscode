/**
 * Pinned Files — pure data layer for the Glubean panel.
 *
 * Manages a list of pinned test files persisted in workspaceState.
 * All functions are pure (testable) except the ones that read/write Memento.
 */

import type * as vscode from "vscode";

// ── Types ─────────────────────────────────────────────────────────────────

export interface PinnedFile {
  type: "file";
  workspaceRoot: string;
  /** Relative to workspaceRoot */
  filePath: string;
  label: string;
}

// ── Storage key ───────────────────────────────────────────────────────────

const STORAGE_KEY = "glubean.pinnedFiles";

// ── Memento-backed persistence ────────────────────────────────────────────

let _state: vscode.Memento | undefined;

export function initPinnedStorage(state: vscode.Memento): void {
  _state = state;
}

// ── Pure helpers (exported for testing) ───────────────────────────────────

/** Deduplicate by (workspaceRoot, filePath) */
export function dedup(items: PinnedFile[]): PinnedFile[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.workspaceRoot}::${item.filePath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Check if a file is already pinned */
export function isPinned(items: PinnedFile[], workspaceRoot: string, filePath: string): boolean {
  return items.some(
    (item) => item.workspaceRoot === workspaceRoot && item.filePath === filePath,
  );
}

/** Add a file to the list (deduped) */
export function addPin(items: PinnedFile[], entry: PinnedFile): PinnedFile[] {
  return dedup([...items, entry]);
}

/** Remove a file from the list */
export function removePin(items: PinnedFile[], workspaceRoot: string, filePath: string): PinnedFile[] {
  return items.filter(
    (item) => !(item.workspaceRoot === workspaceRoot && item.filePath === filePath),
  );
}

/** Filter pinned files by workspace root */
export function filterByRoot(items: PinnedFile[], workspaceRoot: string): PinnedFile[] {
  return items.filter((item) => item.workspaceRoot === workspaceRoot);
}

// ── Read/write through Memento ────────────────────────────────────────────

export function listPinned(): PinnedFile[] {
  if (!_state) return [];
  return _state.get<PinnedFile[]>(STORAGE_KEY) ?? [];
}

export async function savePinned(items: PinnedFile[]): Promise<void> {
  if (!_state) return;
  await _state.update(STORAGE_KEY, items);
}

export async function pinFile(entry: PinnedFile): Promise<void> {
  const current = listPinned();
  const updated = addPin(current, entry);
  await savePinned(updated);
}

export async function unpinFile(workspaceRoot: string, filePath: string): Promise<void> {
  const current = listPinned();
  const updated = removePin(current, workspaceRoot, filePath);
  await savePinned(updated);
}
