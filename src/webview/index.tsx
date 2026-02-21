import { render } from "preact";
import { useState, useEffect } from "preact/hooks";
import { TraceViewer } from "./components/TraceViewer";

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

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

function App() {
  const [data, setData] = useState<TraceViewerData | null>(null);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === "update") {
        setData(msg.data);
      }
    };
    window.addEventListener("message", handler);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", handler);
  }, []);

  if (!data) {
    return (
      <div class="flex items-center justify-center h-screen opacity-50">
        Loading trace…
      </div>
    );
  }

  if (data.calls.length === 0) {
    return (
      <div class="flex flex-col items-center justify-center h-screen gap-2 opacity-50">
        <span class="text-lg">No HTTP calls recorded</span>
        <span class="text-sm">Run the test to generate trace data.</span>
      </div>
    );
  }

  return (
    <TraceViewer
      data={data}
      onViewSource={() => vscode.postMessage({ type: "viewSource" })}
    />
  );
}

render(<App />, document.getElementById("app")!);
