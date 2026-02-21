/**
 * Pure utility functions extracted from testController.ts.
 *
 * These functions have zero dependency on the `vscode` API and can be
 * unit-tested with `node:test` + `node:assert`.
 *
 * Run tests: npx tsx --test src/testController.utils.test.ts
 */

// ---------------------------------------------------------------------------
// Types (shared with testController.ts)
// ---------------------------------------------------------------------------

/** Event from the runner (matches ExecutionEvent union) */
export interface GlubeanEvent {
  type: string;
  // log
  message?: string;
  data?: unknown;
  // assertion
  passed?: boolean;
  actual?: unknown;
  expected?: unknown;
  // status
  status?: string;
  error?: string;
  // step
  index?: number;
  name?: string;
  total?: number;
  durationMs?: number;
  assertions?: number;
  stepIndex?: number;
}

/** A request/response pair from a .trace.jsonc file */
export interface TracePair {
  request: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  };
  response?: unknown;
}

// ---------------------------------------------------------------------------
// Filter ID normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a parser-generated test ID for CLI `--filter` matching.
 *
 * The static parser prefixes data-driven IDs with `each:` or `pick:` and
 * keeps template variables like `$id` or `$_pick`. The CLI runner expands
 * those into concrete values (e.g. `get-user-1`). This function strips the
 * prefix and template variables so the result can be used as a substring
 * filter that matches all expanded variants.
 *
 * For plain test IDs (no prefix) the value is returned unchanged.
 *
 * @example
 * normalizeFilterId("each:get-user-$id")   // "get-user-"
 * normalizeFilterId("pick:search-$_pick")  // "search-"
 * normalizeFilterId("health-check")        // "health-check"
 */
export function normalizeFilterId(id: string): string {
  let f = id;
  if (f.startsWith("each:")) f = f.slice(5);
  else if (f.startsWith("pick:")) f = f.slice(5);
  return f.replace(/\$\w+/g, "");
}

// ---------------------------------------------------------------------------
// Result matching
// ---------------------------------------------------------------------------

/** Minimal shape of a single test entry from the runner's result JSON. */
export interface ResultTestEntry {
  testId: string;
  testName: string;
  success: boolean;
  durationMs: number;
  events: GlubeanEvent[];
}

/**
 * Match parser-generated test metadata to runtime result entries.
 *
 * Uses a two-pass claimed-index algorithm:
 * 1. Exact matches and non-empty prefix matches claim result entries first.
 * 2. Empty-prefix data-driven items (template-only IDs like `each:$id`) get
 *    only the remaining unclaimed entries.
 *
 * Returns an array parallel to `testIds` — each element is the array of
 * matched result entries for that test item.
 */
export function matchTestResults(
  testIds: string[],
  results: ResultTestEntry[],
): ResultTestEntry[][] {
  const claimed = new Set<number>();
  const matched: ResultTestEntry[][] = testIds.map(() => []);

  // Pass 1: non-empty prefix / exact matches
  for (let ti = 0; ti < testIds.length; ti++) {
    const id = testIds[ti];
    const isDataDriven = id.startsWith("each:") || id.startsWith("pick:");

    if (isDataDriven) {
      const prefix = normalizeFilterId(id);
      if (prefix === "") continue; // deferred to pass 2
      for (let ri = 0; ri < results.length; ri++) {
        if (results[ri].testId.startsWith(prefix)) {
          claimed.add(ri);
          matched[ti].push(results[ri]);
        }
      }
    } else {
      const ri = results.findIndex((r) => r.testId === id);
      if (ri >= 0) {
        claimed.add(ri);
        matched[ti].push(results[ri]);
      }
    }
  }

  // Pass 2: empty-prefix data-driven items get unclaimed results
  for (let ti = 0; ti < testIds.length; ti++) {
    const id = testIds[ti];
    const isDataDriven = id.startsWith("each:") || id.startsWith("pick:");
    if (!isDataDriven) continue;

    const prefix = normalizeFilterId(id);
    if (prefix !== "") continue;
    if (matched[ti].length > 0) continue;

    for (let ri = 0; ri < results.length; ri++) {
      if (!claimed.has(ri)) {
        claimed.add(ri);
        matched[ti].push(results[ri]);
      }
    }
  }

  return matched;
}

// ---------------------------------------------------------------------------
// CLI argument builder
// ---------------------------------------------------------------------------

/**
 * Build CLI args for `glubean run`.
 * Always includes --verbose --pretty --result-json --emit-full-trace
 * for maximum output in the Test Results panel.
 *
 * @param filePath   Path to the test file
 * @param filterId   Optional test ID filter (--filter)
 * @param pickKey    Optional test.pick example key (--pick)
 * @param envFile    Optional env file path (--env-file)
 */
export function buildArgs(
  filePath: string,
  filterId?: string,
  pickKey?: string,
  envFile?: string,
  traceLimit?: number,
): string[] {
  const args = [
    "run",
    filePath,
    "--verbose",
    "--pretty",
    "--result-json",
    "--emit-full-trace",
  ];
  if (filterId) {
    args.push("--filter", filterId);
  }
  if (pickKey) {
    args.push("--pick", pickKey);
  }
  if (envFile) {
    args.push("--env-file", envFile);
  }
  if (traceLimit && traceLimit !== 20) {
    args.push("--trace-limit", String(traceLimit));
  }
  return args;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format a JSON value for display — pretty-print if small enough, truncate if large.
 */
export function formatJson(value: unknown, maxLen = 2000): string {
  if (value === undefined || value === null) {
    return "";
  }
  try {
    const str = JSON.stringify(value, null, 2);
    if (str.length > maxLen) {
      return str.slice(0, maxLen) + "\n... (truncated)";
    }
    return str;
  } catch {
    return String(value);
  }
}

/**
 * Format headers as a readable block.
 */
export function formatHeaders(
  headers: Record<string, string> | undefined,
): string {
  if (!headers || Object.keys(headers).length === 0) {
    return "";
  }
  return Object.entries(headers)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");
}

/**
 * Format a single trace event into a multi-line string with full HTTP details.
 */
export function formatTraceEvent(data: Record<string, unknown>): string {
  const method = data.method ?? "???";
  const url = data.url ?? "";
  const status = data.status ?? "";
  const duration = data.duration ?? "";
  const name = data.name ? ` (${data.name})` : "";

  const lines: string[] = [];
  lines.push(`── HTTP ${method} ${url}${name} → ${status} (${duration}ms)`);

  const reqHeaders = data.requestHeaders as Record<string, string> | undefined;
  const resHeaders = data.responseHeaders as Record<string, string> | undefined;
  const reqBody = data.requestBody;
  const resBody = data.responseBody;

  if (reqHeaders && Object.keys(reqHeaders).length > 0) {
    lines.push("  Request Headers:");
    lines.push(formatHeaders(reqHeaders));
  }
  if (reqBody !== undefined) {
    lines.push("  Request Body:");
    lines.push("  " + formatJson(reqBody).replace(/\n/g, "\n  "));
  }
  if (resHeaders && Object.keys(resHeaders).length > 0) {
    lines.push("  Response Headers:");
    lines.push(formatHeaders(resHeaders));
  }
  if (resBody !== undefined) {
    lines.push("  Response Body:");
    lines.push("  " + formatJson(resBody).replace(/\n/g, "\n  "));
  }

  return lines.join("\n");
}

/**
 * Build a structured output block from all events for a test, suitable for
 * the Test Results "message" area. Includes logs, HTTP traces, assertions, etc.
 */
export function buildEventsSummary(events: GlubeanEvent[]): string {
  const lines: string[] = [];

  for (const event of events) {
    switch (event.type) {
      case "log": {
        const dataStr =
          event.data !== undefined ? " " + formatJson(event.data, 500) : "";
        lines.push(`[LOG] ${event.message ?? ""}${dataStr}`);
        break;
      }
      case "trace": {
        const traceData = (event.data ?? {}) as Record<string, unknown>;
        lines.push(formatTraceEvent(traceData));
        break;
      }
      case "assertion": {
        const icon = event.passed ? "✓" : "✗";
        lines.push(`[ASSERT ${icon}] ${event.message ?? ""}`);
        if (!event.passed) {
          if (event.expected !== undefined) {
            lines.push(`  Expected: ${formatJson(event.expected, 500)}`);
          }
          if (event.actual !== undefined) {
            lines.push(`  Actual:   ${formatJson(event.actual, 500)}`);
          }
        }
        break;
      }
      case "warning": {
        lines.push(`[WARN] ${event.message ?? ""}`);
        break;
      }
      case "schema_validation": {
        const ev = event as unknown as Record<string, unknown>;
        const label = ev.label ?? "";
        const success = ev.success ? "✓" : "✗";
        lines.push(`[SCHEMA ${success}] ${label}`);
        const issues = ev.issues as
          | Array<{ message: string; path?: Array<string | number> }>
          | undefined;
        if (issues && issues.length > 0) {
          for (const issue of issues) {
            const p = issue.path ? ` @ ${issue.path.join(".")}` : "";
            lines.push(`  - ${issue.message}${p}`);
          }
        }
        break;
      }
      case "metric": {
        const ev = event as unknown as Record<string, unknown>;
        const unit = ev.unit ? ` ${ev.unit}` : "";
        lines.push(`[METRIC] ${ev.name}: ${ev.value}${unit}`);
        break;
      }
      case "step_start": {
        lines.push(
          `\n━━ Step ${(event.index ?? 0) + 1}/${event.total ?? "?"}: ${
            event.name ?? ""
          } ━━`,
        );
        break;
      }
      case "step_end": {
        const ev = event as unknown as Record<string, unknown>;
        const st = ev.status ?? "unknown";
        const dur = ev.durationMs ? ` (${ev.durationMs}ms)` : "";
        lines.push(`━━ Step done: ${st}${dur}`);
        if (ev.returnState !== undefined) {
          lines.push(`  → return: ${formatJson(ev.returnState, 1000)}`);
        }
        break;
      }
      case "error": {
        lines.push(`[ERROR] ${event.message ?? ""}`);
        break;
      }
      case "status": {
        if (event.error) {
          lines.push(`[STATUS] ${event.status ?? "failed"}: ${event.error}`);
        }
        break;
      }
      default:
        break;
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// cURL generation
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe inclusion inside single-quoted shell arguments.
 * Replaces each `'` with `'\''` (end quote, escaped quote, re-open quote).
 */
function shellEscape(value: string): string {
  return value.replace(/'/g, "'\\''");
}

/**
 * Convert a trace request/response pair into a cURL command string.
 */
export function tracePairToCurl(pair: TracePair): string {
  const req = pair.request;
  const parts: string[] = ["curl"];

  // Method
  if (req.method && req.method.toUpperCase() !== "GET") {
    parts.push(`-X ${req.method.toUpperCase()}`);
  }

  // URL
  parts.push(`'${shellEscape(req.url)}'`);

  // Headers
  if (req.headers) {
    for (const [key, value] of Object.entries(req.headers)) {
      parts.push(`-H '${shellEscape(`${key}: ${value}`)}'`);
    }
  }

  // Body
  if (req.body !== undefined) {
    const bodyStr =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    parts.push(`-d '${shellEscape(bodyStr)}'`);
  }

  return parts.join(" \\\n  ");
}

/**
 * Scan the raw text of a .trace.jsonc file and return the index of the
 * top-level array element that contains `cursorLine`.
 *
 * Uses brace-depth counting: each top-level `{` starts a new element, the
 * matching `}` ends it. Returns 0 as a fallback when the cursor is outside
 * all elements (e.g. on the opening `[` or a comment line).
 */
export function findPairIndexAtLine(text: string, cursorLine: number): number {
  const lines = text.split("\n");
  let depth = 0;
  let elementStart = -1;
  let elementIndex = 0;
  let inString = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inString && line.trimStart().startsWith("//")) continue;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '"' && (j === 0 || line[j - 1] !== "\\")) {
        inString = !inString;
      }
      if (inString) continue;

      if (ch === "{") {
        depth++;
        if (depth === 1) elementStart = i;
      } else if (ch === "}") {
        if (depth === 1) {
          if (cursorLine >= elementStart && cursorLine <= i) return elementIndex;
          elementIndex++;
        }
        depth--;
      }
    }
  }
  return 0;
}
