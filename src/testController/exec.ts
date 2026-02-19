import * as cp from "child_process";
import type * as vscode from "vscode";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `glubean` CLI and capture output.
 * When a TestRun is provided, stdout/stderr lines are streamed into it
 * so the Test Results panel shows live output (logs, HTTP traces, etc.).
 *
 * Note: `run.appendOutput()` requires `\r\n` line endings for proper display.
 */
export function execGlubean(
  command: string,
  args: string[],
  cwd: string,
  cancellation: vscode.CancellationToken,
  run?: vscode.TestRun,
  deps?: {
    spawn?: (
      command: string,
      args: readonly string[],
      options: cp.SpawnOptions,
    ) => cp.ChildProcess;
  },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const spawnImpl = deps?.spawn ?? cp.spawn;
    // No shell: true — args array is passed directly to the binary, avoiding
    // any shell interpolation of paths with spaces or special characters.
    const proc = spawnImpl(command, args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: "1" }, // keep ANSI colors for pretty output
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      if (run) {
        // TestRun.appendOutput requires \r\n line endings
        run.appendOutput(text.replace(/\n/g, "\r\n"));
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      if (run) {
        run.appendOutput(text.replace(/\n/g, "\r\n"));
      }
    });

    const disposable = cancellation.onCancellationRequested(() => {
      proc.kill("SIGTERM");
    });

    proc.on("error", (err) => {
      disposable.dispose();
      reject(err);
    });

    proc.on("close", (code) => {
      disposable.dispose();
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}
