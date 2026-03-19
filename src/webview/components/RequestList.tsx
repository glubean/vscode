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

interface RequestListProps {
  calls: Call[];
  selected: number;
  onSelect: (index: number) => void;
}

const METHOD_CLASSES: Record<string, string> = {
  GET: "method-get method-get-bg",
  POST: "method-post method-post-bg",
  PUT: "method-put method-put-bg",
  PATCH: "method-patch method-patch-bg",
  DELETE: "method-delete method-delete-bg",
};

function statusClass(status: number): string {
  if (status < 300) return "status-ok";
  if (status < 400) return "status-redirect";
  return "status-error";
}

function urlPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function RequestList({ calls, selected, onSelect }: RequestListProps) {
  return (
    <div class="flex flex-col gap-2 p-2">
      {calls.map((call, i) => {
        const isSelected = i === selected;
        return (
          <button
            key={i}
            class={`sidebar-item flex flex-col gap-1.5 px-3 py-2 text-left transition-colors cursor-pointer ${
              isSelected ? "sidebar-item-selected" : ""
            }`}
            onClick={() => onSelect(i)}
          >
            <div class="flex items-center gap-2">
              <span
                class={`px-1.5 py-0.5 text-[10px] font-semibold rounded-full ${
                  METHOD_CLASSES[call.request.method] ?? "muted"
                }${isSelected ? " opacity-90" : ""}`}
              >
                {call.request.method}
              </span>
              <span class={`text-xs ${isSelected ? "opacity-90" : statusClass(call.response.status)}`}>
                {call.response.status}
              </span>
              <span class={`text-[10px] ml-auto ${isSelected ? "opacity-80" : "muted"}`}>
                {call.response.durationMs}ms
              </span>
            </div>
            <div class="text-xs url-font truncate" title={call.request.url}>
              {urlPath(call.request.url)}
            </div>
            <div class={`text-[10px] truncate ${isSelected ? "opacity-70" : "muted"}`}>
              {urlHost(call.request.url)}
            </div>
          </button>
        );
      })}
    </div>
  );
}
