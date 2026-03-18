/**
 * Write run artifacts (result JSON files) after test execution.
 *
 * Replaces the file-writing that the CLI used to do — now that VSCode
 * uses @glubean/runner directly, the extension must write these files
 * so that the result viewer has something to open.
 */

import * as fs from "fs";
import * as path from "path";
import type { GlubeanResult } from "./results";

const RESULT_HISTORY_LIMIT = 20;

/**
 * Write all run artifacts for a completed test execution.
 *
 * 1. Result JSON at `resultJsonPath` (for resultViewer)
 * 2. Result JSON at `.glubean/last-run.result.json` (for task panel / tooling)
 * 3. Per-test mini result files at `.glubean/results/{fileName}/{testId}/{ts}.result.json`
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

  // 3. Write per-test result files
  writeResultFiles(filePath, result, cwd);
}

/**
 * Write per-test mini result files.
 *
 * Path: `.glubean/results/{baseName}/{testId}/{timestamp}.result.json`
 *
 * Each file is a self-contained mini GlubeanResult with a single test entry.
 */
function writeResultFiles(
  filePath: string,
  result: GlubeanResult,
  cwd: string,
): void {
  const now = new Date();
  const ts =
    `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}` +
    `T${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;

  const baseName = path.basename(filePath).replace(/\.(ts|js|mjs)$/, "");

  for (const test of result.tests) {
    const testDir = path.join(
      cwd,
      ".glubean",
      "results",
      baseName,
      sanitize(test.testId),
    );

    try {
      fs.mkdirSync(testDir, { recursive: true });
    } catch {
      continue;
    }

    const miniResult = {
      summary: {
        total: 1,
        passed: test.success ? 1 : 0,
        failed: test.success ? 0 : 1,
        durationMs: test.durationMs ?? 0,
      },
      tests: [test],
      runAt: now.toISOString(),
    };

    const content = JSON.stringify(miniResult, null, 2) + "\n";
    const resultFile = path.join(testDir, `${ts}.result.json`);

    try {
      fs.writeFileSync(resultFile, content, "utf-8");
    } catch {
      // Non-critical
    }

    // Cleanup: keep only the most recent N files
    cleanupResultDir(testDir, RESULT_HISTORY_LIMIT);
  }
}

function p2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function sanitize(s: string): string {
  return s.replace(/[<>:"/\\|?*]/g, "_");
}

function cleanupResultDir(dir: string, limit: number): void {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".result.json"))
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
