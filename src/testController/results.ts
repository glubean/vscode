import * as fs from "fs";
import * as vscode from "vscode";
import type { TestMeta } from "../parser";
import {
  buildEventsSummary,
  matchTestResults,
  type GlubeanEvent,
} from "../testController.utils";

/** Parsed result from --result-json output */
export interface GlubeanResult {
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    durationMs: number;
  };
  tests: Array<{
    testId: string;
    testName: string;
    success: boolean;
    durationMs: number;
    events: GlubeanEvent[];
  }>;
}

/**
 * Read and parse a .result.json file.
 */
export function readResultJson(filePath: string): GlubeanResult | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as GlubeanResult;
  } catch {
    return null;
  }
}

/**
 * Create a TestMessage with an optional source location attached.
 * Reduces boilerplate when building failure messages with navigation.
 */
function messageWithLocation(
  content: string | vscode.MarkdownString,
  location?: vscode.Location,
): vscode.TestMessage {
  const msg = new vscode.TestMessage(content);
  if (location) {
    msg.location = location;
  }
  return msg;
}

/**
 * Apply structured test results to TestRun items, including rich event details.
 */
export function applyResults(
  tests: Array<{ item: vscode.TestItem; meta: TestMeta }>,
  result: GlubeanResult,
  run: vscode.TestRun,
): void {
  const allMatched = matchTestResults(
    tests.map((t) => t.meta.id),
    result.tests,
  );

  for (let i = 0; i < tests.length; i++) {
    const { item } = tests[i];
    const matchedResults = allMatched[i];

    if (matchedResults.length === 0) {
      run.skipped(item);
      continue;
    }

    // Aggregate events and status across all matched results
    const allEvents = matchedResults.flatMap((r) => r.events);
    const allPassed = matchedResults.every((r) => r.success);
    const totalDuration = matchedResults.reduce(
      (s, r) => s + (r.durationMs ?? 0),
      0,
    );
    const displayName = matchedResults
      .map((r) => r.testName)
      .join(", ");

    // Build rich event summary for TestMessage
    const eventsSummary = buildEventsSummary(allEvents);

    if (allPassed) {
      run.passed(item, totalDuration);
      // Even for passing tests, output logs/traces to TestRun output
      if (eventsSummary) {
        run.appendOutput(
          `\n── ${displayName} ──\r\n${eventsSummary.replace(
            /\n/g,
            "\r\n",
          )}\r\n`,
          undefined,
          item,
        );
      }
    } else {
      // Every failure message gets a location so clicking navigates to source.
      const loc =
        item.uri && item.range
          ? new vscode.Location(item.uri, item.range)
          : undefined;
      const messages: vscode.TestMessage[] = [];

      for (const event of allEvents) {
        if (event.type === "assertion" && event.passed === false) {
          const msg = messageWithLocation(
            event.message ?? "Assertion failed",
            loc,
          );
          if (event.expected !== undefined) {
            msg.expectedOutput = JSON.stringify(event.expected);
          }
          if (event.actual !== undefined) {
            msg.actualOutput = JSON.stringify(event.actual);
          }
          messages.push(msg);
        }

        if (event.type === "error" || event.type === "status") {
          if (event.error) {
            messages.push(messageWithLocation(event.error, loc));
          }
        }
      }

      if (messages.length === 0) {
        messages.push(messageWithLocation("Test failed", loc));
      }

      // Append the full event summary (with HTTP traces) as an additional message
      if (eventsSummary) {
        messages.push(
          messageWithLocation(
            new vscode.MarkdownString("```\n" + eventsSummary + "\n```"),
            loc,
          ),
        );
      }

      run.failed(item, messages, totalDuration);
    }

    // Update step children if present — attach per-step output.
    // For data-driven tests use the first matched result for step mapping
    // (each variant shares the same step structure).
    const primaryResult = matchedResults[0];
    item.children.forEach((stepItem) => {
      const stepIndex = parseInt(stepItem.id.split("#step-")[1] ?? "-1");
      if (stepIndex < 0) return;

      // Find the step_end event for status/duration
      const stepEnd = primaryResult.events.find(
        (e) =>
          e.type === "step_end" &&
          (e as unknown as Record<string, unknown>).index === stepIndex,
      );

      // Collect events belonging to this step.
      // Events between step_start and step_end use the `index` field.
      // Some events (like trace, metric) use `stepIndex` instead.
      const stepEvents: GlubeanEvent[] = [];
      let inStep = false;
      for (const e of primaryResult.events) {
        const ev = e as unknown as Record<string, unknown>;
        if (e.type === "step_start" && ev.index === stepIndex) {
          inStep = true;
          continue;
        }
        if (e.type === "step_end" && ev.index === stepIndex) {
          break;
        }
        if (inStep) {
          stepEvents.push(e);
        } else if (ev.stepIndex === stepIndex) {
          // Catch events tagged with stepIndex but outside start/end markers
          stepEvents.push(e);
        }
      }

      // Build and attach per-step output
      const stepSummary = buildEventsSummary(stepEvents);
      if (stepSummary) {
        run.appendOutput(
          `${stepSummary.replace(/\n/g, "\r\n")}\r\n`,
          undefined,
          stepItem,
        );
      }

      if (stepEnd) {
        const ev = stepEnd as unknown as Record<string, unknown>;
        const status = ev.status;
        const duration = ev.durationMs as number | undefined;
        if (status === "passed") {
          run.passed(stepItem, duration);
        } else if (status === "failed") {
          // Use the parent test item's location so clicking navigates to source
          const loc =
            item.uri && item.range
              ? new vscode.Location(item.uri, item.range)
              : undefined;
          const failMessages: vscode.TestMessage[] = [];

          // Include the step_end error message (e.g. "Request failed with status 429")
          if (ev.error && typeof ev.error === "string") {
            failMessages.push(messageWithLocation(ev.error, loc));
          }

          // Include assertion failures from this step
          for (const se of stepEvents) {
            if (se.type === "assertion" && se.passed === false) {
              failMessages.push(
                messageWithLocation(se.message ?? "Assertion failed", loc),
              );
            }
            if (se.type === "error") {
              failMessages.push(
                messageWithLocation(se.message ?? "Error", loc),
              );
            }
          }

          if (failMessages.length === 0) {
            failMessages.push(messageWithLocation("Step failed", loc));
          }

          // Append the full event summary (HTTP traces, logs) for this step
          if (stepSummary) {
            failMessages.push(
              messageWithLocation(
                new vscode.MarkdownString("```\n" + stepSummary + "\n```"),
                loc,
              ),
            );
          }

          run.failed(stepItem, failMessages, duration);
        }
      }
    });
  }
}
