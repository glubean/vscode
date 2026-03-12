/**
 * Write run artifacts (result JSON + trace JSONC files) after test execution.
 *
 * Replaces the file-writing that the CLI used to do — now that VSCode
 * uses @glubean/runner directly, the extension must write these files
 * so that the result viewer and trace viewer have something to open.
 */

import * as fs from "fs";
import * as path from "path";
import type { GlubeanResult } from "./results";
import type { GlubeanEvent } from "../testController.utils";

const TRACE_HISTORY_LIMIT = 20;

/**
 * Write all run artifacts for a completed test execution.
 *
 * 1. Result JSON at `resultJsonPath` (for resultViewer)
 * 2. Result JSON at `.glubean/last-run.result.json` (for task panel / tooling)
 * 3. Trace JSONC files at `.glubean/traces/{fileName}/{testId}/{ts}.trace.jsonc`
 */
export function writeRunArtifacts(
  filePath: string,
  resultJsonPath: string,
  result: GlubeanResult,
  cwd: string,
): void {
  const resultJson = JSON.stringify(result, null, 2);

  // 1. Write per-file result JSON (for resultViewer to open)
  try {
    fs.writeFileSync(resultJsonPath, resultJson, "utf-8");
  } catch {
    // Non-critical
  }

  // 2. Write .glubean/last-run.result.json (for task panel / tooling)
  try {
    const glubeanDir = path.join(cwd, ".glubean");
    fs.mkdirSync(glubeanDir, { recursive: true });
    fs.writeFileSync(
      path.join(glubeanDir, "last-run.result.json"),
      resultJson,
      "utf-8",
    );
  } catch {
    // Non-critical
  }

  // 3. Write trace files
  writeTraceFiles(filePath, result, cwd);
}

/**
 * Write .trace.jsonc files for each test that has trace events.
 *
 * Path: `.glubean/traces/{baseName}/{testId}/{timestamp}.trace.jsonc`
 */
function writeTraceFiles(
  filePath: string,
  result: GlubeanResult,
  cwd: string,
): void {
  const now = new Date();
  const ts =
    `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}` +
    `T${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;

  const baseName = path.basename(filePath).replace(/\.ts$/, "");

  for (const test of result.tests) {
    const pairs = extractTracePairs(test.events);
    if (pairs.length === 0) continue;

    const testDir = path.join(
      cwd,
      ".glubean",
      "traces",
      baseName,
      sanitize(test.testId),
    );

    try {
      fs.mkdirSync(testDir, { recursive: true });
    } catch {
      continue;
    }

    const relFile = path.relative(cwd, filePath);
    const header = [
      `// ${relFile} → ${test.testId} — ${pairs.length} HTTP call${pairs.length > 1 ? "s" : ""}`,
      `// Run at: ${now.toLocaleString()}`,
      "",
    ].join("\n");

    const content = header + JSON.stringify(pairs, null, 2) + "\n";
    const traceFile = path.join(testDir, `${ts}.trace.jsonc`);

    try {
      fs.writeFileSync(traceFile, content, "utf-8");
    } catch {
      // Non-critical
    }

    // Cleanup: keep only the most recent N files
    cleanupTraceDir(testDir, TRACE_HISTORY_LIMIT);
  }
}

/**
 * Extract {request, response} pairs from trace events.
 */
function extractTracePairs(events: GlubeanEvent[]): TracePair[] {
  const pairs: TracePair[] = [];
  for (const event of events) {
    if (event.type !== "trace" || !event.data) continue;
    const d = event.data as Record<string, unknown>;
    pairs.push({
      request: {
        method: (d.method as string) || "?",
        url: (d.url as string) || "",
        ...(d.requestHeaders && Object.keys(d.requestHeaders as object).length > 0
          ? { headers: d.requestHeaders as Record<string, string> }
          : {}),
        ...(d.requestBody !== undefined ? { body: d.requestBody } : {}),
      },
      response: {
        status: (d.status as number) || 0,
        durationMs: (d.duration as number) || 0,
        ...(d.responseHeaders && Object.keys(d.responseHeaders as object).length > 0
          ? { headers: d.responseHeaders as Record<string, string> }
          : {}),
        ...(d.responseBody !== undefined ? { body: d.responseBody } : {}),
      },
    });
  }
  return pairs;
}

interface TracePair {
  request: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  };
  response: {
    status: number;
    durationMs: number;
    headers?: Record<string, string>;
    body?: unknown;
  };
}

function p2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function sanitize(s: string): string {
  return s.replace(/[<>:"/\\|?*]/g, "_");
}

function cleanupTraceDir(dir: string, limit: number): void {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".trace.jsonc"))
      .sort();
    if (files.length <= limit) return;
    const toDelete = files.slice(0, files.length - limit);
    for (const f of toDelete) {
      fs.unlinkSync(path.join(dir, f));
    }
  } catch {
    // Non-critical
  }
}
