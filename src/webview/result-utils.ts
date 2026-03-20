import type { TimelineEvent } from "./index";

/**
 * Derive success from events — soft assertion failures override test.success.
 *
 * Extracted from ResultViewer.tsx so it can be tested without JSX / Preact.
 */
export function deriveSuccess(test: { success: boolean; events: TimelineEvent[] }): boolean {
  if (!test.success) return false;
  return !test.events.some(e => e.type === "assertion" && e.passed === false);
}

/** Extract assertion events from a test's timeline. */
export function extractAssertions(events: TimelineEvent[]): TimelineEvent[] {
  return events.filter(e => e.type === "assertion");
}

/** Extract trace events from a test's timeline. */
export function extractTraceCalls(events: TimelineEvent[]): TimelineEvent[] {
  return events.filter(e => e.type === "trace");
}
