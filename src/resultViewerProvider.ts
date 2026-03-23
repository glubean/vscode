/**
 * Custom Text Editor provider for .result.json files.
 *
 * Shows a summary bar, test list, and raw JSON in CodeMirror.
 * For the full rich viewer, the user can click "Open Full Viewer"
 * which will open glubean.com/viewer.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { getWebviewHtml } from "./webviewUtils";
import { tracePairToCurl } from "./testController.utils";
import { extractTests } from "./parser";
import { inferSourcePath } from "./resultViewerUtils";

// ---------------------------------------------------------------------------
// Types — passed to the webview
// ---------------------------------------------------------------------------

/** Lightweight event suitable for the Events timeline tab. */
export interface TimelineEvent {
  type: string;
  message?: string;
  passed?: boolean;
  actual?: unknown;
  expected?: unknown;
  data?: { method?: string; url?: string; status?: number; duration?: number };
}

/** Full HTTP call data for the Trace tab. */
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

export interface ResultViewerData {
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
      warningTotal?: number;
      warningTriggered?: number;
      stepTotal?: number;
      stepPassed?: number;
      stepFailed?: number;
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

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class ResultViewerProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = "glubean.resultViewer";

  constructor(private readonly extensionUri: vscode.Uri) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "dist", "webview"),
      ],
    };

    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

    const updateWebview = () => {
      const data = this.parseResultDocument(document);
      void webviewPanel.webview.postMessage({
        type: "update",
        viewerType: "result",
        data,
      });
    };

    const messageDisposable = webviewPanel.webview.onDidReceiveMessage(
      async (msg: { type: string; testId?: string; testIds?: string[]; request?: unknown }) => {
        if (msg.type === "ready") {
          updateWebview();
        } else if (msg.type === "jumpToSource" && msg.testId) {
          // Try to find source from result JSON's files field first
          let sourcePath: string | null = null;
          try {
            const resultContent = document.getText();
            const parsed = JSON.parse(resultContent);
            const files: string[] = parsed.files ?? [];
            const cwd = parsed.context?.cwd;
            if (files.length > 0) {
              // Find the file that contains this testId
              for (const f of files) {
                const abs = path.isAbsolute(f)
                  ? f
                  : cwd
                    ? path.resolve(cwd, f)
                    : path.resolve(this.inferProjectRoot(document.uri.fsPath), f);
                if (fs.existsSync(abs)) {
                  const content = fs.readFileSync(abs, "utf-8");
                  const tests = extractTests(content);
                  const hasTest = tests.some((t) => {
                    const bare = t.id.replace(/^(each|pick):/, "");
                    const prefix = bare.replace(/\$[^-]*/g, "");
                    return t.id === msg.testId || bare === msg.testId || (prefix.length > 0 && msg.testId!.startsWith(prefix));
                  });
                  if (hasTest) {
                    sourcePath = abs;
                    break;
                  }
                }
              }
              // If testId not matched but we have files, use first one
              if (!sourcePath && files.length === 1) {
                const abs = path.isAbsolute(files[0])
                  ? files[0]
                  : cwd
                    ? path.resolve(cwd, files[0])
                    : path.resolve(this.inferProjectRoot(document.uri.fsPath), files[0]);
                if (fs.existsSync(abs)) sourcePath = abs;
              }
            }
          } catch { /* ignore parse errors, fallback below */ }

          // Fallback to path-based inference
          if (!sourcePath) {
            sourcePath = inferSourcePath(document.uri.fsPath) ?? null;
          }
          if (!sourcePath) {
            void vscode.window.showWarningMessage(
              "Could not locate the source test file.",
            );
            return;
          }
          try {
            const sourceContent = fs.readFileSync(sourcePath, "utf-8");
            const tests = extractTests(sourceContent);
            // Find the test by testId — try exact match first, then
            // try without variant prefix (pick:/each:) since result testId
            // won't have the prefix.
            const match =
              tests.find((t) => t.id === msg.testId) ??
              tests.find((t) => t.id.replace(/^(each|pick):/, "") === msg.testId) ??
              tests.find((t) => {
                // Data-driven tests: result testId is an instantiated ID
                // like "search-by-name", but source has the template "search-$_pick".
                // Strip variant prefix and check if the template base matches.
                const bare = t.id.replace(/^(each|pick):/, "");
                // Simple heuristic: if the template (with $ placeholders removed up to
                // next separator) is a prefix of the result testId, consider it a match.
                const prefix = bare.replace(/\$[^-]*/g, "");
                return prefix.length > 0 && msg.testId!.startsWith(prefix);
              });
            const line = match?.line ?? 1;
            const uri = vscode.Uri.file(sourcePath);
            const pos = new vscode.Position(line - 1, 0);
            await vscode.window.showTextDocument(uri, {
              selection: new vscode.Range(pos, pos),
              viewColumn: vscode.ViewColumn.One,
            });
          } catch (err) {
            console.error("[Glubean] Failed to jump to source:", err);
            void vscode.window.showWarningMessage(
              "Could not open the source test file.",
            );
          }
        } else if (msg.type === "viewSource") {
          void vscode.commands.executeCommand(
            "vscode.openWith",
            document.uri,
            "default",
          );
        } else if (msg.type === "openFullViewer") {
          void vscode.window.showInformationMessage(
            "Full cloud viewer is coming soon! Stay tuned.",
          );
        } else if (msg.type === "resultPrev") {
          await vscode.commands.executeCommand("glubean.resultPrev");
        } else if (msg.type === "resultNext") {
          await vscode.commands.executeCommand("glubean.resultNext");
        } else if (msg.type === "rerunFailed" && Array.isArray(msg.testIds) && msg.testIds.length > 0) {
          const sourcePath = inferSourcePath(document.uri.fsPath);
          if (!sourcePath) {
            void vscode.window.showWarningMessage(
              "Could not locate the source test file to rerun.",
            );
            return;
          }
          void vscode.commands.executeCommand("glubean.rerunFailed", {
            filePath: sourcePath,
            testIds: msg.testIds,
          });
        } else if (msg.type === "copyAsCurl" && msg.request) {
          const req = msg.request as Record<string, unknown>;
          if (
            typeof req.url !== "string" ||
            typeof req.method !== "string" ||
            (req.headers != null && typeof req.headers !== "object")
          ) return;
          try {
            const curl = tracePairToCurl({
              request: req as { method: string; url: string; headers?: Record<string, string>; body?: unknown },
            });
            await vscode.env.clipboard.writeText(curl);
            await vscode.window.showInformationMessage(
              "cURL command copied to clipboard.",
            );
          } catch (err) {
            console.error("[Glubean] Failed to generate cURL from result viewer:", err);
            await vscode.window.showWarningMessage(
              "Could not generate cURL — the request contains invalid data.",
            );
          }
        }
      },
    );

    const changeDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) {
        updateWebview();
      }
    });

    // Track active state for editor/title menu visibility
    const setActive = (active: boolean) => {
      void vscode.commands.executeCommand(
        "setContext",
        "glubean.resultViewerActive",
        active,
      );
    };

    if (webviewPanel.active) {
      setActive(true);
    }

    const viewStateDisposable = webviewPanel.onDidChangeViewState((e) => {
      setActive(e.webviewPanel.active);
    });

    webviewPanel.onDidDispose(() => {
      messageDisposable.dispose();
      changeDisposable.dispose();
      viewStateDisposable.dispose();
      setActive(false);
    });
  }

  // -------------------------------------------------------------------------
  // JSON parsing
  // -------------------------------------------------------------------------

  private parseResultDocument(
    document: vscode.TextDocument,
  ): ResultViewerData {
    const raw = document.getText();
    const fileName = document.uri.fsPath.split(/[\\/]/).pop() ?? "";

    try {
      const parsed = JSON.parse(raw);
      const tests: ResultViewerData["tests"] = [];

      if (Array.isArray(parsed.tests)) {
        for (const t of parsed.tests) {
          let failureReason: string | undefined;
          if (!t.success && Array.isArray(t.events)) {
            // Take the first failure signal encountered: errors and fatal
            // statuses take priority, followed by the first assertion failure.
            for (const e of t.events) {
              if (e.type === "error" && e.message) {
                failureReason = e.message;
                break;
              }
              if (e.type === "status" && (e.error || e.reason)) {
                failureReason = e.error || e.reason;
                break;
              }
              if (e.type === "assertion" && !e.passed && e.message && !failureReason) {
                failureReason = e.message;
                // Don't break — a later error/status event should still win.
              }
            }
          }

          const trimmedEvents: TimelineEvent[] = [];
          const calls: TraceCall[] = [];
          if (Array.isArray(t.events)) {
            for (const e of t.events) {
              // Build full trace calls for the Trace tab
              if (e.type === "trace" && e.data) {
                calls.push({
                  request: {
                    method: e.data.method ?? "GET",
                    url: e.data.url ?? "",
                    headers: e.data.requestHeaders,
                    body: e.data.requestBody,
                  },
                  response: {
                    status: e.data.status ?? 0,
                    durationMs: e.data.duration ?? 0,
                    headers: e.data.responseHeaders,
                    body: e.data.responseBody,
                  },
                });
              }

              // Build lightweight events for the Events tab
              if (e.type === "summary" || e.type === "status" || e.type === "start") {
                continue;
              }
              trimmedEvents.push({
                type: e.type,
                message: e.message,
                passed: e.passed,
                ...(e.type === "assertion" && e.actual !== undefined
                  ? { actual: e.actual }
                  : {}),
                ...(e.type === "assertion" && e.expected !== undefined
                  ? { expected: e.expected }
                  : {}),
                data: e.data
                  ? {
                      method: e.data.method,
                      url: e.data.url,
                      status: e.data.status,
                      duration: e.data.duration,
                    }
                  : undefined,
              });
            }
          }

          tests.push({
            testId: t.testId ?? "",
            testName: t.testName ?? t.testId ?? "",
            success: !!t.success,
            durationMs: t.durationMs ?? 0,
            tags: t.tags,
            failureReason,
            events: trimmedEvents,
            calls,
          });
        }
      }

      return {
        fileName,
        runAt: parsed.runAt ?? "",
        target: parsed.target ?? "",
        files: parsed.files ?? [],
        summary: {
          total: parsed.summary?.total ?? 0,
          passed: parsed.summary?.passed ?? 0,
          failed: parsed.summary?.failed ?? 0,
          skipped: parsed.summary?.skipped ?? 0,
          durationMs: parsed.summary?.durationMs ?? 0,
          stats: parsed.summary?.stats,
        },
        tests,
        rawJson: raw,
      };
    } catch {
      return {
        fileName,
        runAt: "",
        target: "",
        files: [],
        summary: {
          total: 0,
          passed: 0,
          failed: 0,
          skipped: 0,
          durationMs: 0,
        },
        tests: [],
        rawJson: raw,
      };
    }
  }

  /**
   * Infer the project root from a result file path.
   * .glubean/last-run.result.json → go up 2 levels
   * .glubean/results/xxx/yyy/ts.result.json → go up to before .glubean
   * foo.test.result.json (beside file) → dirname
   */
  private inferProjectRoot(resultPath: string): string {
    const parts = resultPath.split(path.sep);
    const glubeanIdx = parts.lastIndexOf(".glubean");
    if (glubeanIdx >= 0) {
      return parts.slice(0, glubeanIdx).join(path.sep);
    }
    return path.dirname(resultPath);
  }

  // -------------------------------------------------------------------------
  // Webview HTML
  // -------------------------------------------------------------------------

  private getHtmlForWebview(webview: vscode.Webview): string {
    return getWebviewHtml(webview, this.extensionUri, "Result Viewer");
  }
}
