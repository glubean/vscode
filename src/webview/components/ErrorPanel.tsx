/**
 * Error panel for the result viewer "Errors" tab.
 *
 * Displays error and failed status events with structured reason labels.
 * Shown only when the test has errors; acts as the default tab for failed tests.
 */

import type { TimelineEvent } from "../index";

interface ErrorPanelProps {
  tests: Array<{
    testId: string;
    testName: string;
    success: boolean;
    events: TimelineEvent[];
  }>;
}

const REASON_LABELS: Record<string, string> = {
  http_timeout: "HTTP Timeout",
  test_timeout: "Test Timeout",
  network: "Network Error",
  oom: "Out of Memory",
};

function ErrorCard({ testName, error, reason }: { testName: string; error: string; reason?: string }) {
  const label = reason ? REASON_LABELS[reason] ?? reason : undefined;

  return (
    <div
      class="rounded-md p-4 text-xs"
      style="background: color-mix(in srgb, var(--vscode-testing-iconFailed, #f85149) 8%, transparent); border: 1px solid color-mix(in srgb, var(--vscode-testing-iconFailed, #f85149) 25%, transparent)"
    >
      <div class="flex items-center gap-2 mb-2">
        <span style="color: var(--vscode-testing-iconFailed, #f85149)">✗</span>
        <span class="font-medium">{testName}</span>
      </div>
      {label && (
        <span
          class="inline-block text-[10px] font-medium px-2 py-0.5 rounded-full mb-2"
          style="background: color-mix(in srgb, var(--vscode-testing-iconFailed, #f85149) 15%, transparent); color: var(--vscode-testing-iconFailed, #f85149)"
        >
          {label}
        </span>
      )}
      <div class="mt-1" style="color: var(--vscode-testing-iconFailed, #f85149)">
        {error}
      </div>
    </div>
  );
}

export function ErrorPanel({ tests }: ErrorPanelProps) {
  const errors: Array<{ testName: string; error: string; reason?: string }> = [];

  for (const test of tests) {
    if (test.success) continue;
    for (const ev of test.events) {
      if (ev.type === "error" && (ev.message || ev.error)) {
        errors.push({
          testName: test.testName,
          error: (ev.message || ev.error) as string,
          reason: ev.reason,
        });
        break; // one error per test
      }
      if (ev.type === "status" && ev.error) {
        errors.push({
          testName: test.testName,
          error: ev.error,
          reason: ev.reason,
        });
        break;
      }
    }
  }

  if (errors.length === 0) {
    return <div class="text-xs muted italic p-4">No errors.</div>;
  }

  return (
    <div class="p-4 flex flex-col gap-3 overflow-y-auto h-full">
      {errors.map((err, i) => (
        <ErrorCard key={i} testName={err.testName} error={err.error} reason={err.reason} />
      ))}
    </div>
  );
}

/** Count error events across all tests. */
export function countErrors(tests: Array<{ success: boolean; events: TimelineEvent[] }>): number {
  let count = 0;
  for (const test of tests) {
    if (test.success) continue;
    for (const ev of test.events) {
      if ((ev.type === "error" && (ev.message || ev.error)) || (ev.type === "status" && ev.error)) {
        count++;
        break;
      }
    }
  }
  return count;
}
