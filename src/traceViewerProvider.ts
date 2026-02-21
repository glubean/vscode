/**
 * Custom Text Editor provider for .trace.jsonc files.
 *
 * Renders trace data (HTTP request/response pairs) as a rich Preact-based
 * webview instead of raw JSON text. Users can always "Reopen Editor With…"
 * to fall back to the standard text editor.
 */

import * as vscode from "vscode";
import * as path from "path";
import { getWebviewHtml } from "./webviewUtils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class TraceViewerProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = "glubean.traceViewer";

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
      const data = this.parseTraceDocument(document);
      void webviewPanel.webview.postMessage({ type: "update", viewerType: "trace", data });
    };

    // Send initial data once the webview signals it is ready
    const messageDisposable = webviewPanel.webview.onDidReceiveMessage(
      (msg: { type: string }) => {
        if (msg.type === "ready") {
          updateWebview();
        } else if (msg.type === "viewSource") {
          void vscode.commands.executeCommand(
            "vscode.openWith",
            document.uri,
            "default",
          );
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

    return {
      meta: { ...meta, callCount: calls.length },
      calls,
    };
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

