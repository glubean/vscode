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
}

function HeadersTable({ headers }: { headers?: Record<string, string> }) {
  if (!headers || Object.keys(headers).length === 0) {
    return <div class="text-xs muted italic">No headers</div>;
  }

  return (
    <table class="w-full text-xs code-font">
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
      <pre class="text-xs code-font whitespace-pre-wrap break-all">{body}</pre>
    );
  }

  return <CodeViewer data={body} />;
}

function statusClass(status: number): string {
  if (status < 300) return "status-ok";
  if (status < 400) return "status-redirect";
  return "status-error";
}

export function RequestDetail({ call }: RequestDetailProps) {
  const { request, response } = call;

  return (
    <div class="flex flex-col h-full">
      {/* URL bar */}
      <div class="flex items-center gap-2 px-3 py-2 border-b border-panel">
        <span class="text-xs font-semibold">{request.method}</span>
        <span class="text-xs code-font truncate flex-1" title={request.url}>
          {request.url}
        </span>
        <span class={`text-xs font-semibold ${statusClass(response.status)}`}>
          {response.status}
          {response.statusText ? ` ${response.statusText}` : ""}
        </span>
        <span class="text-[10px] muted">{response.durationMs}ms</span>
      </div>

      {/* Tabbed content */}
      <div class="flex-1 overflow-hidden">
        <Tabs
          tabs={[
            {
              id: "response-body",
              label: "Response",
              content: <BodyView body={response.body} />,
            },
            {
              id: "request-body",
              label: "Request",
              content: <BodyView body={request.body} />,
            },
            {
              id: "response-headers",
              label: `Response Headers${
                response.headers
                  ? ` (${Object.keys(response.headers).length})`
                  : ""
              }`,
              content: <HeadersTable headers={response.headers} />,
            },
            {
              id: "request-headers",
              label: `Request Headers${
                request.headers
                  ? ` (${Object.keys(request.headers).length})`
                  : ""
              }`,
              content: <HeadersTable headers={request.headers} />,
            },
          ]}
        />
      </div>
    </div>
  );
}
