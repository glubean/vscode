import * as cp from "child_process";
import * as http from "http";
import * as net from "net";

/**
 * Find a free TCP port starting from `base`.
 * Tries up to 20 consecutive ports before giving up.
 */
export function findFreePort(base: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    function tryPort(port: number): void {
      const server = net.createServer();
      server.once("error", () => {
        attempts++;
        if (attempts > 20) {
          reject(new Error("Could not find a free port for debugger"));
        } else {
          tryPort(port + 1);
        }
      });
      server.once("listening", () => {
        server.close(() => resolve(port));
      });
      server.listen(port, "127.0.0.1");
    }

    tryPort(base);
  });
}

/**
 * Poll the V8 Inspector HTTP endpoint until it responds.
 * Returns the WebSocket debugger URL from the /json response.
 *
 * This is more reliable than parsing stderr because stderr output can get
 * lost or buffered when the process tree involves shell wrappers and
 * multiple layers of subprocess inheritance.
 */
export function pollInspectorReady(
  port: number,
  timeoutMs = 15000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let done = false;

    function attempt(): void {
      if (done) return;
      if (Date.now() - startTime > timeoutMs) {
        done = true;
        reject(
          new Error(
            `Timed out waiting for V8 Inspector on port ${port} (${timeoutMs}ms)`,
          ),
        );
        return;
      }

      const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          if (done) return;
          try {
            const targets = JSON.parse(data);
            if (Array.isArray(targets) && targets.length > 0) {
              const wsUrl = targets[0].webSocketDebuggerUrl;
              if (wsUrl) {
                done = true;
                resolve(wsUrl);
                return;
              }
            }
          } catch {
            // JSON parse failed, retry
          }
          // Got a response but no valid target yet, retry
          setTimeout(attempt, 200);
        });
      });
      req.on("error", () => {
        // Connection refused — inspector not ready yet, retry
        if (!done) {
          setTimeout(attempt, 200);
        }
      });
      req.end();
    }

    attempt();
  });
}

/**
 * Kill an entire process group (detached process).
 * Falls back to killing just the process if group kill fails.
 */
export function killProcessGroup(proc: cp.ChildProcess): void {
  const pid = proc.pid;
  if (!pid) return;

  try {
    // Kill the entire process group (negative PID)
    process.kill(-pid, "SIGTERM");
  } catch {
    // Fallback: kill just the process
    try {
      proc.kill("SIGTERM");
    } catch {
      // already dead
    }
  }

  // Force kill after 2s grace period
  const forceKillTimer = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
  }, 2000);
  proc.once("close", () => clearTimeout(forceKillTimer));
}
