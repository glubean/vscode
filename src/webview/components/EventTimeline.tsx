/**
 * Lightweight event timeline for the ResultViewer "Events" tab.
 *
 * Renders events grouped by test case with type-specific icons.
 * Includes a CTA at the bottom to guide users toward Glubean Cloud.
 */

import type { TimelineEvent } from "../index";

interface EventTimelineProps {
  tests: Array<{
    testId: string;
    testName: string;
    success: boolean;
    events: TimelineEvent[];
  }>;
  onOpenCloud?: () => void;
}

const EVENT_ICONS: Record<string, string> = {
  trace: "⇄",
  assertion: "✓",
  log: "▸",
  metric: "◈",
  error: "✗",
  warning: "⚠",
};

function formatTraceEvent(ev: TimelineEvent): string {
  const d = ev.data;
  if (!d) return ev.message ?? "HTTP request";
  const parts: string[] = [];
  if (d.method) parts.push(d.method);
  if (d.url) {
    try {
      const u = new URL(d.url);
      parts.push(u.pathname + u.search);
    } catch {
      parts.push(d.url);
    }
  }
  if (d.status != null) parts.push(`→ ${d.status}`);
  if (d.duration != null) parts.push(`(${d.duration}ms)`);
  return parts.join(" ");
}

function EventRow({ ev }: { ev: TimelineEvent }) {
  const icon = EVENT_ICONS[ev.type] ?? "·";
  const isFailedAssertion = ev.type === "assertion" && ev.passed === false;
  const isError = ev.type === "error";

  let message: string;
  if (ev.type === "trace") {
    message = formatTraceEvent(ev);
  } else if (ev.type === "metric" && ev.data) {
    message = ev.message ?? `${ev.data.duration ?? 0}ms`;
  } else {
    message = ev.message ?? ev.type;
  }

  const color = isFailedAssertion || isError
    ? "var(--vscode-testing-iconFailed, #f85149)"
    : ev.type === "assertion" && ev.passed
      ? "var(--vscode-testing-iconPassed, #3fb950)"
      : ev.type === "trace"
        ? "var(--vscode-textLink-foreground, #3794ff)"
        : undefined;

  const iconDisplay = isFailedAssertion ? "✗" : icon;

  return (
    <div class="flex items-start gap-2 py-1 text-xs">
      <span
        class="shrink-0 w-4 text-center"
        style={color ? { color } : undefined}
      >
        {iconDisplay}
      </span>
      <span
        class="min-w-0 wrap-break-word"
        style={color ? { color } : undefined}
      >
        {message}
      </span>
    </div>
  );
}

export function EventTimeline({ tests, onOpenCloud }: EventTimelineProps) {
  const hasEvents = tests.some((t) => t.events.length > 0);

  if (!hasEvents) {
    return (
      <div class="text-xs muted italic p-4">
        No events recorded for this run.
      </div>
    );
  }

  return (
    <div class="flex flex-col gap-0">
      {tests.map((test) => (
        <div key={test.testId}>
          {/* Test group header */}
          <div
            class="flex items-center gap-2 px-1 py-1.5 text-[10px] font-medium uppercase tracking-wide sticky top-0"
            style="background: var(--vscode-editor-background, #1e1e1e); color: var(--vscode-descriptionForeground, #a1a1a1)"
          >
            <span
              style={`color: var(${test.success ? "--vscode-testing-iconPassed, #3fb950" : "--vscode-testing-iconFailed, #f85149"})`}
            >
              {test.success ? "✓" : "✗"}
            </span>
            <span class="truncate">{test.testName}</span>
          </div>

          {/* Events */}
          <div class="pl-2">
            {test.events.map((ev, i) => (
              <EventRow key={`${test.testId}-${i}`} ev={ev} />
            ))}
          </div>
        </div>
      ))}

      {/* Cloud CTA */}
      {onOpenCloud && (
        <div
          class="flex items-center justify-center gap-2 px-3 py-3 mt-2 border-t text-xs"
          style="border-color: var(--vscode-panel-border, var(--vscode-widget-border, #333))"
        >
          <span class="muted">
            Want filtering, search, and historical trends?
          </span>
          <button
            onClick={onOpenCloud}
            class="px-2 py-1 rounded text-[10px] cursor-pointer transition-colors"
            style="background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff)"
            onMouseEnter={(e) => {
              (e.target as HTMLElement).style.background =
                "var(--vscode-button-hoverBackground, #1177bb)";
            }}
            onMouseLeave={(e) => {
              (e.target as HTMLElement).style.background =
                "var(--vscode-button-background, #0e639c)";
            }}
          >
            Open in Glubean Cloud
          </button>
        </div>
      )}
    </div>
  );
}
