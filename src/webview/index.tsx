import { render } from "preact";
import { useState, useEffect } from "preact/hooks";
import { TraceViewer } from "./components/TraceViewer";
import { ResultViewer } from "./components/ResultViewer";

type ViewerState =
  | { type: "loading" }
  | { type: "trace"; data: TraceData }
  | { type: "result"; data: ResultData };

interface TraceData {
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

export interface TimelineEvent {
  type: string;
  message?: string;
  passed?: boolean;
  data?: { method?: string; url?: string; status?: number; duration?: number };
}

export interface TraceCall {
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
}

export interface ResultData {
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

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

function App() {
  const [state, setState] = useState<ViewerState>({ type: "loading" });

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === "update") {
        if (msg.viewerType === "result") {
          setState({ type: "result", data: msg.data });
        } else {
          setState({ type: "trace", data: msg.data });
        }
      }
    };
    window.addEventListener("message", handler);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", handler);
  }, []);

  if (state.type === "loading") {
    return (
      <div class="flex items-center justify-center h-screen opacity-50">
        Loading…
      </div>
    );
  }

  if (state.type === "result") {
    return (
      <ResultViewer
        data={state.data}
        onOpenFullViewer={() => vscode.postMessage({ type: "openFullViewer" })}
      />
    );
  }

  // Trace viewer
  const traceData = state.data;
  if (traceData.calls.length === 0) {
    return (
      <div class="flex flex-col items-center justify-center h-screen gap-2 opacity-50">
        <span class="text-lg">No HTTP calls recorded</span>
        <span class="text-sm">Run the test to generate trace data.</span>
      </div>
    );
  }

  return (
    <TraceViewer
      data={traceData}
      onCopyAsCurl={(call) =>
        vscode.postMessage({ type: "copyAsCurl", request: call.request })
      }
    />
  );
}

render(<App />, document.getElementById("app")!);
