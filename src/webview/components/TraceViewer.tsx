import { useState } from "preact/hooks";
import { RequestList } from "./RequestList";
import { RequestDetail } from "./RequestDetail";

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
}

interface TraceViewerProps {
  data: TraceViewerData;
  onCopyAsCurl?: (call: TraceViewerData["calls"][0]) => void;
}

export function TraceViewer({ data, onCopyAsCurl }: TraceViewerProps) {
  const [selected, setSelected] = useState(0);
  const call = data.calls[selected];

  const isSingleCall = data.calls.length === 1;

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
      </div>

      {/* Main content */}
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
    </div>
  );
}
