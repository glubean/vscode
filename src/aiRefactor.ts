/**
 * AI Refactor Hint — VSCode command registration.
 *
 * VX-3: Surfaces lightweight AI-assisted refactor hints via CodeLens.
 * Clipboard-only — no AI provider integration.
 *
 * Pure functions live in aiRefactorCore.ts for testability.
 */

import * as vscode from "vscode";
import type { TestMeta } from "./parser";
import { buildPrompt, type Scenario } from "./aiRefactorCore";

// Re-export pure functions so codeLensProvider can import from here
export { detectRefactorScenarios, type Scenario } from "./aiRefactorCore";

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerAiRefactorCommand(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "glubean.aiRefactor",
      async (args: {
        filePath: string;
        exportName: string;
        testId: string;
        line: number;
        scenarios: Scenario[];
      }) => {
        if (!args?.scenarios?.length) return;

        let selectedScenario: Scenario;

        if (args.scenarios.length === 1) {
          // Single scenario — skip QuickPick, use directly
          selectedScenario = args.scenarios[0];
        } else {
          // Multiple scenarios — show QuickPick
          const items = args.scenarios.map((s) => ({
            label: s.label,
            detail: s.detail,
            scenario: s,
          }));

          const picked = await vscode.window.showQuickPick(items, {
            placeHolder: "Select a refactor action",
            title: "Refactor",
          });

          if (!picked) return;
          selectedScenario = picked.scenario;
        }

        // Build the test meta from args
        const meta: TestMeta = {
          type: "test",
          id: args.testId,
          exportName: args.exportName,
          line: args.line,
        };

        const prompt = buildPrompt(
          selectedScenario,
          args.filePath,
          meta,
        );

        // Show toast with actions
        const action = await vscode.window.showInformationMessage(
          `${selectedScenario.label} — copy and paste to your AI agent`,
          "Copy to Clipboard",
          "Preview",
        );

        if (action === "Copy to Clipboard") {
          await vscode.env.clipboard.writeText(prompt);
          vscode.window.showInformationMessage(
            "Copied! Paste into Claude Code, Cursor, or any AI agent.",
          );
        } else if (action === "Preview") {
          const doc = await vscode.workspace.openTextDocument({
            content: prompt,
            language: "markdown",
          });
          await vscode.window.showTextDocument(doc, { preview: true });
        }
      },
    ),
  );
}
