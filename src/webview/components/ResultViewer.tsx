/**
 * Result viewer: summary bar + test list + trace details + events + raw JSON.
 *
 * Single-test results skip the test list and show Trace + Assertions directly.
 * Multi-test results show the full test list with expandable details.
 */

import { useState } from "preact/hooks";
import { CodeViewer } from "./CodeViewer";
import { EventTimeline } from "./EventTimeline";
import { AssertionList } from "./AssertionList";
import { RequestList } from "./RequestList";
import { RequestDetail } from "./RequestDetail";
import { Tabs } from "./Tabs";
import type { TimelineEvent, TraceCall } from "../index";

interface ResultViewerData {
  fileName: string;
  runAt: string;
  target: string;
  files: string[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    durationMs: number;
    stats?: {
      httpRequestTotal?: number;
      httpErrorTotal?: number;
      assertionTotal?: number;
      assertionFailed?: number;
    };
  };
  tests: Array<{
    testId: string;
    testName: string;
    success: boolean;
    durationMs: number;
    tags?: string[];
    failureReason?: string;
    events: TimelineEvent[];
    calls: TraceCall[];
  }>;
  rawJson: string;
}

interface ResultViewerProps {
  data: ResultViewerData;
  onOpenFullViewer?: () => void;
  onNewer?: () => void;
  onOlder?: () => void;
  onCopyAsCurl?: (call: TraceCall) => void;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function StatusIcon({ success }: { success: boolean }) {
  if (success) {
    return <span class="text-xs" style="color: var(--vscode-testing-iconPassed, #3fb950)">✓</span>;
  }
  return <span class="text-xs" style="color: var(--vscode-testing-iconFailed, #f85149)">✗</span>;
}

function SummaryBar({ summary, runAt }: { summary: ResultViewerData["summary"]; runAt: string }) {
  return (
    <div class="flex items-center gap-4 flex-wrap">
      <div class="flex items-center gap-1.5">
        <span class="font-medium" style="color: var(--vscode-testing-iconPassed, #3fb950)">
          {summary.passed}
        </span>
        <span class="muted text-[10px]">passed</span>
      </div>

      {summary.failed > 0 && (
        <div class="flex items-center gap-1.5">
          <span class="font-medium" style="color: var(--vscode-testing-iconFailed, #f85149)">
            {summary.failed}
          </span>
          <span class="muted text-[10px]">failed</span>
        </div>
      )}

      {summary.skipped > 0 && (
        <div class="flex items-center gap-1.5">
          <span class="font-medium" style="color: var(--vscode-debugConsole-warningForeground, #d29922)">
            {summary.skipped}
          </span>
          <span class="muted text-[10px]">skipped</span>
        </div>
      )}

      <span class="muted">·</span>
      <span class="text-xs muted">{summary.total} tests</span>
      <span class="text-xs muted">{formatDuration(summary.durationMs)}</span>

      {summary.stats?.httpRequestTotal != null && summary.stats.httpRequestTotal > 0 && (
        <>
          <span class="muted">·</span>
          <span class="text-xs muted">{summary.stats.httpRequestTotal} requests</span>
        </>
      )}

      {summary.stats?.assertionTotal != null && summary.stats.assertionTotal > 0 && (
        <>
          <span class="muted">·</span>
          <span class="text-xs muted">{summary.stats.assertionTotal} assertions</span>
        </>
      )}

      {runAt && (
        <>
          <span class="muted ml-auto">·</span>
          <span class="text-xs muted">{runAt}</span>
        </>
      )}
    </div>
  );
}

function TestList({ tests }: { tests: ResultViewerData["tests"] }) {
  if (tests.length === 0) {
    return <div class="text-xs muted italic p-4">No tests found</div>;
  }

  return (
    <div>
      {tests.map((test, i) => (
        <div
          key={test.testId}
          class="flex items-start gap-2 px-3 py-2 text-xs"
          style={i > 0 ? "border-top: 1px solid rgba(128,128,128,0.12)" : undefined}
        >
          <StatusIcon success={test.success} />
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="code-font truncate">{test.testName}</span>
              {test.tags && test.tags.length > 0 && (
                <div class="flex gap-1">
                  {test.tags.map((tag) => (
                    <span key={tag} class="text-[9px] px-1 py-0.5 rounded bg-badge">{tag}</span>
                  ))}
                </div>
              )}
            </div>
            {test.failureReason && (
              <div
                class="mt-0.5 text-[10px] truncate"
                title={test.failureReason}
                style="color: var(--vscode-testing-iconFailed, #f85149)"
              >
                {test.failureReason}
              </div>
            )}
          </div>
          <span class="muted whitespace-nowrap shrink-0">{formatDuration(test.durationMs)}</span>
        </div>
      ))}
    </div>
  );
}

function TraceTab({ tests, onCopyAsCurl }: { tests: ResultViewerData["tests"]; onCopyAsCurl?: (call: TraceCall) => void }) {
  const [selectedTest, setSelectedTest] = useState(0);
  const [selectedCall, setSelectedCall] = useState(0);
  const test = tests[selectedTest];
  const calls = test?.calls ?? [];
  const call = calls[selectedCall];

  const hasCalls = tests.some((t) => t.calls.length > 0);
  if (!hasCalls) {
    return <div class="text-xs muted italic p-4">No HTTP traces recorded.</div>;
  }

  return (
    <div class="flex flex-col h-full">
      {/* Test selector (only when >1 test) */}
      {tests.length > 1 && (
        <div class="flex gap-0 border-b border-panel shrink-0 overflow-x-auto">
          {tests.map((t, i) => (
            <button
              key={t.testId}
              class={`px-3 py-1.5 text-[10px] whitespace-nowrap border-b-2 transition-colors cursor-pointer ${
                i === selectedTest
                  ? "tab-active"
                  : "border-transparent muted hover:text-(--vscode-editor-foreground)"
              }`}
              onClick={() => { setSelectedTest(i); setSelectedCall(0); }}
            >
              <StatusIcon success={t.success} />{" "}
              {t.testName}
            </button>
          ))}
        </div>
      )}

      {calls.length === 0 ? (
        <div class="text-xs muted italic p-4">No HTTP calls in this test.</div>
      ) : (
        <div class="flex flex-1 overflow-hidden">
          {calls.length > 1 && (
            <div class="w-56 shrink-0 overflow-y-auto border-r border-panel">
              <RequestList
                calls={calls}
                selected={selectedCall}
                onSelect={setSelectedCall}
              />
            </div>
          )}
          <div class="flex-1 overflow-hidden">
            {call && (
              <RequestDetail
                call={call}
                onCopyAsCurl={
                  onCopyAsCurl ? () => onCopyAsCurl(call) : undefined
                }
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function ResultViewer({ data, onOpenFullViewer, onNewer, onOlder, onCopyAsCurl }: ResultViewerProps) {
  const allPassed = data.summary.failed === 0 && data.summary.skipped === 0;
  const isSingleTest = data.tests.length === 1;

  return (
    <div class="flex flex-col h-screen">
      {/* Header */}
      <div class="flex items-center gap-3 px-3 py-2 border-b border-panel shrink-0 bg-sidebar">
        <span
          class="text-xs font-semibold"
          style={`color: var(${allPassed ? "--vscode-testing-iconPassed, #3fb950" : "--vscode-testing-iconFailed, #f85149"})`}
        >
          {allPassed ? "PASSED" : "FAILED"}
        </span>
        <span class="text-xs truncate muted">
          {isSingleTest ? data.tests[0].testName : data.fileName}
        </span>
        {isSingleTest && (
          <span class="text-xs muted">{formatDuration(data.tests[0].durationMs)}</span>
        )}
        <div class="ml-auto flex items-center gap-2">
          {onOpenFullViewer && (
            <button
              onClick={onOpenFullViewer}
              class="text-[10px] px-2 py-1 rounded transition-colors cursor-pointer shrink-0"
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
              Open Full Viewer ↗
            </button>
          )}
          <span class="flex items-center gap-1 border-l border-panel pl-3 ml-1">
            <button class="nav-btn" onClick={onNewer} title="Newer result (Cmd+Alt+])">&#x2039;</button>
            <button class="nav-btn" onClick={onOlder} title="Older result (Cmd+Alt+[)">&#x203a;</button>
          </span>
        </div>
      </div>

      {/* Summary bar (multi-test only) */}
      {!isSingleTest && (
        <div class="px-3 py-2 border-b border-panel shrink-0 text-xs">
          <SummaryBar summary={data.summary} runAt={data.runAt} />
        </div>
      )}

      {/* Content — single test vs multi test */}
      {isSingleTest ? (
        <SingleTestView test={data.tests[0]} rawJson={data.rawJson} onOpenCloud={onOpenFullViewer} onCopyAsCurl={onCopyAsCurl} />
      ) : (
        <MultiTestView data={data} onOpenFullViewer={onOpenFullViewer} onCopyAsCurl={onCopyAsCurl} />
      )}
    </div>
  );
}

/**
 * Single-test view: skip the test list, show Trace + Assertions tabs directly.
 */
function SingleTestView({
  test,
  rawJson,
  onOpenCloud,
  onCopyAsCurl,
}: {
  test: ResultViewerData["tests"][0];
  rawJson: string;
  onOpenCloud?: () => void;
  onCopyAsCurl?: (call: TraceCall) => void;
}) {
  const [selectedCall, setSelectedCall] = useState(0);
  const calls = test.calls;
  const call = calls[selectedCall];

  const assertions = test.events.filter((e) => e.type === "assertion");

  return (
    <div class="flex-1 overflow-hidden">
      <Tabs
        tabs={[
          {
            id: "trace",
            label: `Trace (${calls.length})`,
            content: calls.length === 0 ? (
              <div class="text-xs muted italic p-4">No HTTP traces recorded.</div>
            ) : (
              <div class="flex flex-1 overflow-hidden h-full">
                {calls.length > 1 && (
                  <div class="w-56 shrink-0 overflow-y-auto border-r border-panel">
                    <RequestList
                      calls={calls}
                      selected={selectedCall}
                      onSelect={setSelectedCall}
                    />
                  </div>
                )}
                <div class="flex-1 overflow-hidden">
                  {call && (
                    <RequestDetail
                      call={call}
                      onCopyAsCurl={
                        onCopyAsCurl ? () => onCopyAsCurl(call) : undefined
                      }
                    />
                  )}
                </div>
              </div>
            ),
          },
          {
            id: "assertions",
            label: `Assertions (${assertions.length})`,
            content: (
              <div class="overflow-y-auto h-full">
                <AssertionList assertions={assertions} />
              </div>
            ),
          },
          {
            id: "events",
            label: "Events",
            content: (
              <div class="overflow-y-auto h-full">
                <EventTimeline
                  tests={[test]}
                  onOpenCloud={onOpenCloud}
                />
              </div>
            ),
          },
          {
            id: "json",
            label: "Raw JSON",
            content: <CodeViewer data={rawJson} />,
          },
        ]}
      />
    </div>
  );
}

/**
 * Multi-test view: full test list + trace/assertions/events/json tabs.
 */
function MultiTestView({
  data,
  onOpenFullViewer,
  onCopyAsCurl,
}: {
  data: ResultViewerData;
  onOpenFullViewer?: () => void;
  onCopyAsCurl?: (call: TraceCall) => void;
}) {
  return (
    <div class="flex-1 overflow-hidden">
      <Tabs
        tabs={[
          {
            id: "tests",
            label: `Tests (${data.summary.total})`,
            content: (
              <div class="overflow-y-auto h-full">
                <TestList tests={data.tests} />
              </div>
            ),
          },
          {
            id: "trace",
            label: "Trace",
            content: <TraceTab tests={data.tests} onCopyAsCurl={onCopyAsCurl} />,
          },
          {
            id: "assertions",
            label: `Assertions${
              data.summary.stats?.assertionTotal != null
                ? ` (${data.summary.stats.assertionTotal})`
                : ""
            }`,
            content: (
              <div class="overflow-y-auto h-full">
                <AssertionList
                  assertions={data.tests.flatMap((t) =>
                    t.events.filter((e) => e.type === "assertion"),
                  )}
                />
              </div>
            ),
          },
          {
            id: "events",
            label: "Events",
            content: (
              <div class="overflow-y-auto h-full">
                <EventTimeline
                  tests={data.tests}
                  onOpenCloud={onOpenFullViewer}
                />
              </div>
            ),
          },
          {
            id: "json",
            label: "Raw JSON",
            content: <CodeViewer data={data.rawJson} />,
          },
        ]}
      />
    </div>
  );
}
