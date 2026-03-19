import { Tabs } from "./Tabs";
import { CodeViewer } from "./CodeViewer";

interface Call {
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

interface RequestDetailProps {
  call: Call;
  onCopyAsCurl?: () => void;
}

function HeadersTable({ headers }: { headers?: Record<string, string> }) {
  if (!headers || Object.keys(headers).length === 0) {
    return <div class="text-xs muted italic">No headers</div>;
  }

  return (
    <table class="w-full text-xs">
      <tbody>
        {Object.entries(headers).map(([key, value]) => (
          <tr key={key} class="border-b border-panel">
            <td class="py-1 pr-3 tok-key whitespace-nowrap align-top">
              {key}
            </td>
            <td class="py-1 tok-string break-all">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BodyView({ body }: { body?: unknown }) {
  if (body === undefined || body === null) {
    return <div class="text-xs muted italic">No body</div>;
  }

  if (typeof body === "string") {
    return (
      <pre class="text-xs whitespace-pre-wrap break-all">{body}</pre>
    );
  }

  return <CodeViewer data={body} />;
}

function statusClass(status: number): string {
  if (status < 300) return "status-ok";
  if (status < 400) return "status-redirect";
  return "status-error";
}

export function RequestDetail({ call, onCopyAsCurl }: RequestDetailProps) {
  const { request, response } = call;

  return (
    <div class="flex flex-col h-full min-h-0">
      {/* URL bar */}
      <div class="flex items-center gap-2 px-3 py-2 border-b border-panel surface-slate">
        <span
          class="px-2 py-0.5 text-[10px] font-semibold rounded-full surface-slate"
        >
          {request.method}
        </span>
        <span class="text-xs url-font truncate flex-1" title={request.url}>
          {request.url}
        </span>
        <span class={`text-xs font-semibold ${statusClass(response.status)}`}>
          {response.status}
          {response.statusText ? ` ${response.statusText}` : ""}
        </span>
        <span class="text-[10px] muted">{response.durationMs}ms</span>
        {onCopyAsCurl && (
          <button
            class="text-[10px] px-2 py-1 rounded-full border border-panel muted hover:text-[var(--vscode-editor-foreground)] cursor-pointer transition-colors"
            onClick={onCopyAsCurl}
            title="Copy as cURL"
          >
            cURL
          </button>
        )}
      </div>

      {/* Tabbed content */}
      <div class="flex-1 min-h-0 overflow-hidden">
        <Tabs
          tabs={[
            {
              id: "response-body",
              label: "Response",
              content: <div class="p-3 h-full overflow-auto"><BodyView body={response.body} /></div>,
            },
            {
              id: "request-body",
              label: "Request",
              content: <div class="p-3 h-full overflow-auto"><BodyView body={request.body} /></div>,
            },
            {
              id: "response-headers",
              label: `Response Headers${
                response.headers
                  ? ` (${Object.keys(response.headers).length})`
                  : ""
              }`,
              content: <div class="p-3 h-full overflow-auto"><HeadersTable headers={response.headers} /></div>,
            },
            {
              id: "request-headers",
              label: `Request Headers${
                request.headers
                  ? ` (${Object.keys(request.headers).length})`
                  : ""
              }`,
              content: <div class="p-3 h-full overflow-auto"><HeadersTable headers={request.headers} /></div>,
            },
          ]}
        />
      </div>
    </div>
  );
}
