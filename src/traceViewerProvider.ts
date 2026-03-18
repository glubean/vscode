/**
 * Custom Text Editor provider for .trace.jsonc files.
 *
 * Renders trace data (HTTP request/response pairs) as a rich Preact-based
 * webview instead of raw JSON text. Users can always "Reopen Editor With…"
 * to fall back to the standard text editor.
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getWebviewHtml } from "./webviewUtils";
import { tracePairToCurl } from "./testController.utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Assertion event passed to the webview. */
interface AssertionEvent {
  type: "assertion";
  message?: string;
  passed?: boolean;
  actual?: unknown;
  expected?: unknown;
}

export interface TraceViewerData {
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
  assertions?: AssertionEvent[];
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class TraceViewerProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = "glubean.traceViewer";

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onOpen?: () => void,
  ) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    this.onOpen?.();

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "dist", "webview"),
      ],
    };

    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

    const updateWebview = () => {
      const data = this.parseTraceDocument(document);
      void webviewPanel.webview.postMessage({ type: "update", viewerType: "trace", data });
    };

    // Send initial data once the webview signals it is ready
    const messageDisposable = webviewPanel.webview.onDidReceiveMessage(
      async (msg: { type: string; request?: unknown }) => {
        if (msg.type === "ready") {
          updateWebview();
        } else if (msg.type === "tracePrev") {
          await vscode.commands.executeCommand("glubean.tracePrev");
        } else if (msg.type === "traceNext") {
          await vscode.commands.executeCommand("glubean.traceNext");
        } else if (msg.type === "viewSource") {
          void vscode.commands.executeCommand(
            "vscode.openWith",
            document.uri,
            "default",
          );
        } else if (msg.type === "copyAsCurl" && msg.request) {
          const req = msg.request as Record<string, unknown>;
          if (
            typeof req.url !== "string" ||
            typeof req.method !== "string" ||
            (req.headers != null && typeof req.headers !== "object")
          ) return;
          try {
            const curl = tracePairToCurl({
              request: req as TraceViewerData["calls"][0]["request"],
            });
            await vscode.env.clipboard.writeText(curl);
            await vscode.window.showInformationMessage(
              "cURL command copied to clipboard.",
            );
          } catch (err) {
            console.error("[Glubean] Failed to generate cURL from trace viewer:", err);
            await vscode.window.showWarningMessage(
              "Could not generate cURL — the request contains invalid data.",
            );
          }
        }
      },
    );

    // Re-send when the underlying document changes (e.g. trace navigator
    // switches to a different file that VS Code opens in the same tab)
    const changeDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) {
        updateWebview();
      }
    });

    // Track active state for editor/title menu visibility
    const setActive = (active: boolean) => {
      void vscode.commands.executeCommand(
        "setContext",
        "glubean.traceViewerActive",
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
  // JSONC parsing
  // -------------------------------------------------------------------------

  private parseTraceDocument(document: vscode.TextDocument): TraceViewerData {
    const raw = document.getText();
    const meta = this.parseCommentHeader(raw);

    let calls: TraceViewerData["calls"] = [];
    try {
      // Strip only leading comment lines (the JSONC header), not the entire
      // document — a full-document replace could corrupt JSON string values
      // that happen to contain "//".
      const stripped = raw.replace(/^(\s*\/\/[^\n]*\n)+/, "");
      const parsed: unknown = JSON.parse(stripped);
      if (Array.isArray(parsed)) {
        calls = parsed;
      }
    } catch {
      // Malformed JSON — show empty state
    }

    // Try to load assertions from the corresponding result JSON.
    // Trace files live at .glubean/traces/{baseName}/{testId}/{ts}.trace.jsonc
    // Result JSON lives at .glubean/last-run.result.json
    const assertions = this.loadAssertions(document.uri.fsPath, meta.testId);

    return {
      meta: { ...meta, callCount: calls.length },
      calls,
      ...(assertions.length > 0 ? { assertions } : {}),
    };
  }

  /**
   * Load assertion events from the last-run result JSON for the given testId.
   *
   * The trace file path tells us the .glubean directory location:
   *   .glubean/traces/{baseName}/{testId}/{ts}.trace.jsonc
   * We walk up to .glubean/ and read last-run.result.json.
   */
  private loadAssertions(
    traceFilePath: string,
    testId: string,
  ): AssertionEvent[] {
    if (!testId) return [];

    try {
      // Walk up from the trace file to find .glubean/
      // Path: .../.glubean/traces/{baseName}/{testId}/{ts}.trace.jsonc
      const tracesDir = path.dirname(path.dirname(path.dirname(traceFilePath)));
      const glubeanDir = path.dirname(tracesDir);
      const resultPath = path.join(glubeanDir, "last-run.result.json");

      if (!fs.existsSync(resultPath)) return [];

      const raw = fs.readFileSync(resultPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.tests)) return [];

      // Find the test entry matching our testId
      const test = parsed.tests.find(
        (t: { testId?: string }) => t.testId === testId,
      );
      if (!test || !Array.isArray(test.events)) return [];

      const assertions: AssertionEvent[] = [];
      for (const e of test.events) {
        if (e.type !== "assertion") continue;
        assertions.push({
          type: "assertion",
          message: e.message,
          passed: e.passed,
          ...(e.actual !== undefined ? { actual: e.actual } : {}),
          ...(e.expected !== undefined ? { expected: e.expected } : {}),
        });
      }
      return assertions;
    } catch {
      return [];
    }
  }

  /**
   * Extract metadata from the JSONC comment header.
   *
   * Expected format (3 lines):
   *   // tests/foo.test.ts → test-id — 2 HTTP call(s)
   *   // Run at: 2026-02-20 10:37:06
   *   // Environment: .env
   */
  private parseCommentHeader(text: string): {
    file: string;
    testId: string;
    runAt: string;
    env: string;
  } {
    const lines = text.split("\n").slice(0, 5);
    let file = "";
    let testId = "";
    let runAt = "";
    let env = "";

    for (const line of lines) {
      const trimmed = line.replace(/^\s*\/\/\s*/, "");

      const headerMatch = trimmed.match(
        /^(.+?)\s*→\s*(.+?)\s*—\s*\d+\s+HTTP/,
      );
      if (headerMatch) {
        file = headerMatch[1].trim();
        testId = headerMatch[2].trim();
        continue;
      }

      const runAtMatch = trimmed.match(/^Run at:\s*(.+)/);
      if (runAtMatch) {
        runAt = runAtMatch[1].trim();
        continue;
      }

      const envMatch = trimmed.match(/^Environment:\s*(.+)/);
      if (envMatch) {
        env = envMatch[1].trim();
      }
    }

    return { file, testId, runAt, env };
  }

  // -------------------------------------------------------------------------
  // Webview HTML
  // -------------------------------------------------------------------------

  private getHtmlForWebview(webview: vscode.Webview): string {
    return getWebviewHtml(webview, this.extensionUri, "Trace Viewer");
  }
}

