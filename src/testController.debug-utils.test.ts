import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import * as http from "node:http";
import { EventEmitter } from "node:events";
import {
  findFreePort,
  killProcessGroup,
  pollInspectorReady,
} from "./testController.debug-utils";

class FakeProcess extends EventEmitter {
  pid?: number;
  killCalls: string[] = [];

  constructor(pid?: number) {
    super();
    this.pid = pid;
  }

  kill(signal: string): void {
    this.killCalls.push(signal);
  }
}

describe("debug utils", () => {
  it("finds the next free port when base port is occupied", async () => {
    const occupied = http.createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", () => resolve());
    });
    const base = (occupied.address() as { port: number }).port;

    const found = await findFreePort(base);
    assert.ok(found >= base);
    assert.notEqual(found, base);

    await new Promise<void>((resolve, reject) => {
      occupied.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("polls inspector endpoint and returns websocket URL", async () => {
    const inspectorUrl = "ws://127.0.0.1:9229/abc";
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ webSocketDebuggerUrl: inspectorUrl }]));
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as { port: number }).port;

    const wsUrl = await pollInspectorReady(port, 1500);
    assert.equal(wsUrl, inspectorUrl);

    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("falls back to proc.kill when process group kill fails", (t) => {
    const proc = new FakeProcess(43210);
    t.mock.method(process, "kill", () => {
      throw new Error("group kill failed");
    });

    killProcessGroup(proc as never);
    proc.emit("close");

    assert.equal(proc.killCalls[0], "SIGTERM");
  });
});
