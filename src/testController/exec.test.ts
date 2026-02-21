import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import type * as cp from "node:child_process";
import { execGlubean } from "./exec";

class FakeStream extends EventEmitter {
  emitData(text: string): void {
    this.emit("data", Buffer.from(text));
  }
}

class FakeProcess extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  killCalls: string[] = [];

  kill(signal: string): void {
    this.killCalls.push(signal);
  }
}

function createCancellationToken(): {
  token: {
    onCancellationRequested(listener: () => void): { dispose(): void };
  };
  cancel(): void;
} {
  let listener: (() => void) | undefined;
  return {
    token: {
      onCancellationRequested(next: () => void): { dispose(): void } {
        listener = next;
        return { dispose(): void {} };
      },
    },
    cancel(): void {
      listener?.();
    },
  };
}

describe("execGlubean", () => {
  it("captures stdout/stderr and streams CRLF output", async () => {
    const fakeProc = new FakeProcess();

    const appended: string[] = [];
    const run = {
      appendOutput(text: string): void {
        appended.push(text);
      },
    };
    const { token } = createCancellationToken();

    const resultPromise = execGlubean(
      "glubean",
      ["run", "tests/demo.test.ts"],
      "/tmp/work",
      token as never,
      run as never,
      {
        spawn: () => fakeProc as unknown as cp.ChildProcess,
      },
    );

    fakeProc.stdout.emitData("line-a\n");
    fakeProc.stderr.emitData("line-b\n");
    fakeProc.emit("close", 0);

    const result = await resultPromise;
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "line-a\n");
    assert.equal(result.stderr, "line-b\n");
    assert.deepEqual(appended, ["line-a\r\n", "line-b\r\n"]);
  });

  it("kills process on cancellation", async () => {
    const fakeProc = new FakeProcess();

    const { token, cancel } = createCancellationToken();
    const resultPromise = execGlubean(
      "glubean",
      ["run", "tests/demo.test.ts"],
      "/tmp/work",
      token as never,
      undefined,
      {
        spawn: () => fakeProc as unknown as cp.ChildProcess,
      },
    );

    cancel();
    fakeProc.emit("close", 130);

    const result = await resultPromise;
    assert.equal(result.exitCode, 130);
    assert.deepEqual(fakeProc.killCalls, ["SIGTERM"]);
  });
});
