/**
 * Shared Assertions list component used by both TraceViewer and ResultViewer.
 *
 * Displays assertion events with pass/fail status, message, and
 * expected/actual values for failures.
 */

import type { TimelineEvent } from "../index";

interface AssertionListProps {
  assertions: TimelineEvent[];
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return String(value);
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function AssertionRow({ assertion }: { assertion: TimelineEvent }) {
  const passed = assertion.passed !== false;
  const icon = passed ? "\u2713" : "\u2717";
  const color = passed
    ? "var(--vscode-testing-iconPassed, #3fb950)"
    : "var(--vscode-testing-iconFailed, #f85149)";

  return (
    <div
      class="flex flex-col gap-1 px-3 py-2 text-xs"
      style={
        !passed
          ? {
              background:
                "color-mix(in srgb, var(--vscode-testing-iconFailed, #f85149) 8%, transparent)",
            }
          : undefined
      }
    >
      <div class="flex items-start gap-2">
        <span class="shrink-0 font-medium" style={{ color }}>
          {icon}
        </span>
        <span class="min-w-0 wrap-break-word" style={!passed ? { color } : undefined}>
          {assertion.message ?? (passed ? "Passed" : "Failed")}
        </span>
      </div>

      {!passed && (assertion.expected !== undefined || assertion.actual !== undefined) && (
        <div class="pl-5 flex flex-col gap-0.5 code-font text-[10px]">
          {assertion.expected !== undefined && (
            <div class="flex gap-1">
              <span class="muted shrink-0">Expected:</span>
              <pre class="whitespace-pre-wrap break-all m-0">
                {formatValue(assertion.expected)}
              </pre>
            </div>
          )}
          {assertion.actual !== undefined && (
            <div class="flex gap-1">
              <span class="muted shrink-0">Actual:</span>
              <pre
                class="whitespace-pre-wrap break-all m-0"
                style={{ color }}
              >
                {formatValue(assertion.actual)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function AssertionList({ assertions }: AssertionListProps) {
  if (assertions.length === 0) {
    return (
      <div class="text-xs muted italic p-4">
        No assertions recorded.
      </div>
    );
  }

  const passed = assertions.filter((a) => a.passed !== false).length;
  const failed = assertions.length - passed;

  return (
    <div class="flex flex-col">
      {/* Summary line */}
      <div class="flex items-center gap-3 px-3 py-2 border-b text-xs" style="border-color: rgba(128,128,128,0.12)">
        <span style="color: var(--vscode-testing-iconPassed, #3fb950)">{passed} passed</span>
        {failed > 0 && (
          <span style="color: var(--vscode-testing-iconFailed, #f85149)">{failed} failed</span>
        )}
        <span class="muted">{assertions.length} total</span>
      </div>

      {/* Assertion rows */}
      {assertions.map((a, i) => (
        <div
          key={i}
          style={i > 0 ? { borderTop: "1px solid rgba(128,128,128,0.12)" } : undefined}
        >
          <AssertionRow assertion={a} />
        </div>
      ))}
    </div>
  );
}
