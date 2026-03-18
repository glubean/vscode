import { useState } from "preact/hooks";
import { RequestList } from "./RequestList";
import { RequestDetail } from "./RequestDetail";
import { AssertionList } from "./AssertionList";
import type { TimelineEvent } from "../index";

interface TraceViewerData {
  meta: {
    file: string;
    testId: string;
    callCount: number;
    runAt: string;
    env: string;
  };
  calls: Array<{
    request: {
      method: string;
      url: string;
      headers?: Record<string, string>;
      body?: unknown;
    };
    response: {
      status: number;
      statusText?: string;
      durationMs: number;
      headers?: Record<string, string>;
      body?: unknown;
    };
  }>;
  assertions?: TimelineEvent[];
}

interface TraceViewerProps {
  data: TraceViewerData;
  onNewer?: () => void;
  onOlder?: () => void;
  onCopyAsCurl?: (call: TraceViewerData["calls"][0]) => void;
}

type TraceTab = "requests" | "assertions";

export function TraceViewer({ data, onNewer, onOlder, onCopyAsCurl }: TraceViewerProps) {
  const [selected, setSelected] = useState(0);
  const [activeTab, setActiveTab] = useState<TraceTab>("requests");
  const call = data.calls[selected];

  const isSingleCall = data.calls.length === 1;
  const assertions = data.assertions ?? [];
  const hasAssertions = assertions.length > 0;

  return (
    <div class="flex flex-col h-screen">
      {/* Header bar */}
      <div class="flex items-center gap-3 px-3 py-2 border-b border-panel shrink-0 bg-sidebar">
        <span class="text-xs font-medium truncate">{data.meta.testId}</span>
        <span class="text-[10px] muted">{data.meta.file}</span>
        <span class="text-[10px] muted ml-auto">
          {data.meta.callCount} call{data.meta.callCount !== 1 ? "s" : ""}
        </span>
        {data.meta.env && (
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-badge">
            {data.meta.env}
          </span>
        )}
        {data.meta.runAt && (
          <span class="text-[10px] muted">{data.meta.runAt}</span>
        )}
        <span class="flex items-center gap-1 border-l border-panel pl-3 ml-1">
          <button class="nav-btn" onClick={onNewer} title="Newer trace (Cmd+Alt+])">&#x2039;</button>
          <button class="nav-btn" onClick={onOlder} title="Older trace (Cmd+Alt+[)">&#x203a;</button>
        </span>
      </div>

      {/* Tab bar (only shown when assertions exist) */}
      {hasAssertions && (
        <div class="flex gap-0 border-b border-panel shrink-0">
          <button
            class={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
              activeTab === "requests"
                ? "tab-active"
                : "border-transparent muted hover:text-[var(--vscode-editor-foreground)]"
            }`}
            onClick={() => setActiveTab("requests")}
          >
            Requests ({data.calls.length})
          </button>
          <button
            class={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
              activeTab === "assertions"
                ? "tab-active"
                : "border-transparent muted hover:text-[var(--vscode-editor-foreground)]"
            }`}
            onClick={() => setActiveTab("assertions")}
          >
            Assertions ({assertions.length})
          </button>
        </div>
      )}

      {/* Main content */}
      {activeTab === "requests" ? (
        <div class="flex flex-1 overflow-hidden">
          {/* Request list (hidden for single-call traces) */}
          {!isSingleCall && (
            <div class="w-56 shrink-0 overflow-y-auto border-r border-panel">
              <RequestList
                calls={data.calls}
                selected={selected}
                onSelect={setSelected}
              />
            </div>
          )}

          {/* Detail panel */}
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
      ) : (
        <div class="flex-1 overflow-y-auto">
          <AssertionList assertions={assertions} />
        </div>
      )}
    </div>
  );
}
