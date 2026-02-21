/**
 * Custom Text Editor provider for .result.json files.
 *
 * Shows a summary bar, test list, and raw JSON in CodeMirror.
 * For the full rich viewer, the user can click "Open Full Viewer"
 * which will open glubean.com/viewer.
 */

import * as vscode from "vscode";
import { getWebviewHtml } from "./webviewUtils";

// ---------------------------------------------------------------------------
// Types — passed to the webview
// ---------------------------------------------------------------------------

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
      (msg: { type: string }) => {
        if (msg.type === "ready") {
          updateWebview();
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

          tests.push({
            testId: t.testId ?? "",
            testName: t.testName ?? t.testId ?? "",
            success: !!t.success,
            durationMs: t.durationMs ?? 0,
            tags: t.tags,
            failureReason,
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

  // -------------------------------------------------------------------------
  // Webview HTML
  // -------------------------------------------------------------------------

  private getHtmlForWebview(webview: vscode.Webview): string {
    return getWebviewHtml(webview, this.extensionUri, "Result Viewer");
  }
}
