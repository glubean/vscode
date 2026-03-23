/**
 * Pinned Tests — pure data layer for the Glubean panel.
 *
 * Manages a list of pinned individual tests persisted in workspaceState.
 * All functions are pure (testable) except the ones that read/write Memento.
 */

import type * as vscode from "vscode";

// ── Types ─────────────────────────────────────────────────────────────────

export interface PinnedTest {
  type: "test";
  workspaceRoot: string;
  /** Relative to workspaceRoot */
  filePath: string;
  testId: string;
  exportName: string;
  /** Display label: test name or testId */
  label: string;
}

// ── Storage key ───────────────────────────────────────────────────────────

const STORAGE_KEY = "glubean.pinnedTests";

// ── Memento-backed persistence ────────────────────────────────────────────

let _state: vscode.Memento | undefined;

export function initPinnedTestStorage(state: vscode.Memento): void {
  _state = state;
}

// ── Pure helpers (exported for testing) ───────────────────────────────────

/** Deduplicate by (workspaceRoot, filePath, testId) */
export function dedupTests(items: PinnedTest[]): PinnedTest[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.workspaceRoot}::${item.filePath}::${item.testId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Check if a test is already pinned */
export function isPinnedTest(
  items: PinnedTest[],
  workspaceRoot: string,
  filePath: string,
  testId: string,
): boolean {
  return items.some(
    (item) =>
      item.workspaceRoot === workspaceRoot &&
      item.filePath === filePath &&
      item.testId === testId,
  );
}

/** Add a test to the list (deduped) */
export function addPinTest(items: PinnedTest[], entry: PinnedTest): PinnedTest[] {
  return dedupTests([...items, entry]);
}

/** Remove a test from the list */
export function removePinTest(
  items: PinnedTest[],
  workspaceRoot: string,
  filePath: string,
  testId: string,
): PinnedTest[] {
  return items.filter(
    (item) =>
      !(
        item.workspaceRoot === workspaceRoot &&
        item.filePath === filePath &&
        item.testId === testId
      ),
  );
}

/** Filter pinned tests by workspace root */
export function filterTestsByRoot(items: PinnedTest[], workspaceRoot: string): PinnedTest[] {
  return items.filter((item) => item.workspaceRoot === workspaceRoot);
}

// ── Read/write through Memento ────────────────────────────────────────────

export function listPinnedTests(): PinnedTest[] {
  if (!_state) return [];
  return _state.get<PinnedTest[]>(STORAGE_KEY) ?? [];
}

export async function savePinnedTests(items: PinnedTest[]): Promise<void> {
  if (!_state) return;
  await _state.update(STORAGE_KEY, items);
}

export async function pinTest(entry: PinnedTest): Promise<void> {
  const current = listPinnedTests();
  const updated = addPinTest(current, entry);
  await savePinnedTests(updated);
}

export async function unpinTest(
  workspaceRoot: string,
  filePath: string,
  testId: string,
): Promise<void> {
  const current = listPinnedTests();
  const updated = removePinTest(current, workspaceRoot, filePath, testId);
  await savePinnedTests(updated);
}
