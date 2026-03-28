import { render } from "preact";
import { useState, useEffect } from "preact/hooks";
import { ResultViewer } from "./components/ResultViewer";

type ViewerState =
  | { type: "loading" }
  | { type: "result"; data: ResultData };

export interface TimelineEvent {
  type: string;
  message?: string;
  passed?: boolean;
  actual?: unknown;
  expected?: unknown;
  data?: { method?: string; url?: string; status?: number; duration?: number };
}

export interface TraceCall {
  protocol?: string;
  target?: string;
  request: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  };
  response: {
    status: number | string;
    statusText?: string;
    durationMs: number;
    headers?: Record<string, string>;
    body?: unknown;
  };
  metadata?: Record<string, unknown>;
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
        setState({ type: "result", data: msg.data });
      }
    };
    window.addEventListener("message", handler);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", handler);
  }, []);

  if (state.type === "loading") {
    return (
      <div class="flex items-center justify-center h-full opacity-50">
        Loading…
      </div>
    );
  }

  return (
    <ResultViewer
      data={state.data}
      onOpenFullViewer={() => vscode.postMessage({ type: "openFullViewer" })}
      onNewer={() => vscode.postMessage({ type: "resultNext" })}
      onOlder={() => vscode.postMessage({ type: "resultPrev" })}
      onCopyAsCurl={(call) =>
        vscode.postMessage({ type: "copyAsCurl", request: call.request })
      }
      onJumpToSource={(testId) =>
        vscode.postMessage({ type: "jumpToSource", testId })
      }
      onRerunFailed={(testIds) =>
        vscode.postMessage({ type: "rerunFailed", testIds })
      }
    />
  );
}

render(<App />, document.getElementById("app")!);
