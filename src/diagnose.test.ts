/**
 * Tests for diagnose.ts pure helper functions.
 *
 * Run with: npx tsx --test src/diagnose.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

// ---------------------------------------------------------------------------
// Import pure functions under test
// These are the testable, side-effect-free functions from diagnose.ts.
// We replicate them here to avoid importing vscode-dependent module.
// ---------------------------------------------------------------------------

// Replicate: formatVersion
function formatVersion(
  version: string | undefined,
  nodePath?: string,
): string {
  if (!version) return "not found";
  if (nodePath) return `${version} (${nodePath})`;
  return version;
}

// Replicate: detectMode
function detectMode(hasNodeModulesSdk: boolean): "project" | "scratch" {
  return hasNodeModulesSdk ? "project" : "scratch";
}

// Replicate: countEnvVars (uses parseEnvContent logic from envLoader.ts)
function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function countEnvVars(envContent: string): number {
  return Object.keys(parseEnvContent(envContent)).length;
}

// Replicate: Issue type + formatIssues
interface Issue {
  level: "warn" | "error";
  message: string;
}

function formatIssues(issues: Issue[]): string {
  if (issues.length === 0) {
    return "  \u2713 No issues detected";
  }
  return issues.map((i) => `  - ${i.message}`).join("\n");
}

// Replicate: detectIssues
interface DiagnosticData {
  nodeVersion: string | undefined;
  nodePath: string | undefined;
  vscodeVersion: string;
  extensionVersion: string;
  cliVersion: string | undefined;
  cliSource: "local" | "global" | undefined;
  workspaceFolders: WorkspaceDiag[];
  discovery: { autoDiscover: boolean; layout: string; filesFound: number; testItemCount: number };
  currentFile: { filePath: string; fileName: string; recognized: boolean; exports: any[]; pickExampleCount: number; dataLoaderCount: number } | undefined;
}

interface WorkspaceDiag {
  folderPath: string;
  mode: "project" | "scratch";
  hasPackageJson: boolean;
  packageType: string | undefined;
  sdkVersion: string | undefined;
  envStatus: { exists: boolean; varCount: number };
  envSecretsStatus: { exists: boolean; varCount: number };
}

function detectIssues(data: DiagnosticData): Issue[] {
  const issues: Issue[] = [];

  if (!data.nodeVersion) {
    issues.push({ level: "error", message: "Node.js not found \u2014 required to run tests" });
  } else {
    const major = parseInt(data.nodeVersion.replace("v", ""), 10);
    if (major < 20) {
      issues.push({
        level: "warn",
        message: `Node.js version ${data.nodeVersion} detected, 20+ recommended`,
      });
    }
  }

  if (!data.cliVersion) {
    issues.push({
      level: "warn",
      message: "@glubean/cli not found \u2014 run: npm install --save-dev @glubean/cli",
    });
  }

  for (const ws of data.workspaceFolders) {
    const name = ws.folderPath.split("/").pop() || ws.folderPath;
    if (ws.mode === "scratch") {
      issues.push({
        level: "warn",
        message: `${name}: scratch mode \u2014 no @glubean/sdk in node_modules`,
      });
    }
    if (ws.hasPackageJson && ws.packageType !== "module") {
      issues.push({
        level: "warn",
        message: `${name}: package.json "type" is "${ws.packageType ?? "commonjs"}", "module" recommended`,
      });
    }
    if (!ws.envSecretsStatus.exists) {
      issues.push({
        level: "warn",
        message: `${name}: .env.secrets not found \u2014 secrets will be undefined`,
      });
    }
  }

  if (data.discovery.filesFound === 0 && data.discovery.autoDiscover) {
    issues.push({
      level: "warn",
      message: "No .test.{ts,js,mjs} files found in workspace",
    });
  }

  if (data.currentFile && !data.currentFile.recognized) {
    issues.push({
      level: "warn",
      message: `File "${data.currentFile.fileName}" not recognized \u2014 missing @glubean/sdk import`,
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Tests: formatVersion
// ---------------------------------------------------------------------------

describe("formatVersion", () => {
  it("returns 'not found' when version is undefined", () => {
    assert.equal(formatVersion(undefined), "not found");
  });

  it("returns version string when no path given", () => {
    assert.equal(formatVersion("v22.4.0"), "v22.4.0");
  });

  it("includes path when provided", () => {
    assert.equal(
      formatVersion("v22.4.0", "/usr/local/bin/node"),
      "v22.4.0 (/usr/local/bin/node)",
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: detectMode
// ---------------------------------------------------------------------------

describe("detectMode", () => {
  it("returns 'project' when SDK is in node_modules", () => {
    assert.equal(detectMode(true), "project");
  });

  it("returns 'scratch' when SDK is not in node_modules", () => {
    assert.equal(detectMode(false), "scratch");
  });
});

// ---------------------------------------------------------------------------
// Tests: countEnvVars
// ---------------------------------------------------------------------------

describe("countEnvVars", () => {
  it("counts key=value lines", () => {
    assert.equal(countEnvVars("A=1\nB=2\nC=3"), 3);
  });

  it("ignores comments and blank lines", () => {
    assert.equal(countEnvVars("# comment\n\nA=1\n# another\nB=2"), 2);
  });

  it("returns 0 for empty content", () => {
    assert.equal(countEnvVars(""), 0);
  });

  it("returns 0 for comments-only content", () => {
    assert.equal(countEnvVars("# just a comment\n# another"), 0);
  });
});

// ---------------------------------------------------------------------------
// Tests: formatIssues
// ---------------------------------------------------------------------------

describe("formatIssues", () => {
  it("returns success message when no issues", () => {
    assert.equal(formatIssues([]), "  \u2713 No issues detected");
  });

  it("formats single issue", () => {
    const result = formatIssues([{ level: "warn", message: "test warning" }]);
    assert.equal(result, "  - test warning");
  });

  it("formats multiple issues", () => {
    const result = formatIssues([
      { level: "warn", message: "warning 1" },
      { level: "error", message: "error 1" },
    ]);
    assert.equal(result, "  - warning 1\n  - error 1");
  });
});

// ---------------------------------------------------------------------------
// Tests: detectIssues
// ---------------------------------------------------------------------------

function makeBaseData(overrides: Partial<DiagnosticData> = {}): DiagnosticData {
  return {
    nodeVersion: "v22.4.0",
    nodePath: "/usr/local/bin/node",
    vscodeVersion: "1.96.0",
    extensionVersion: "0.14.0",
    cliVersion: "0.1.22",
    cliSource: "local",
    workspaceFolders: [
      {
        folderPath: "/Users/x/my-project",
        mode: "project",
        hasPackageJson: true,
        packageType: "module",
        sdkVersion: "0.1.20",
        envStatus: { exists: true, varCount: 6 },
        envSecretsStatus: { exists: true, varCount: 2 },
      },
    ],
    discovery: { autoDiscover: true, layout: "auto", filesFound: 8, testItemCount: 23 },
    currentFile: undefined,
    ...overrides,
  };
}

describe("detectIssues", () => {
  it("returns empty array for healthy project", () => {
    const issues = detectIssues(makeBaseData());
    assert.equal(issues.length, 0);
  });

  it("detects missing Node.js", () => {
    const issues = detectIssues(makeBaseData({ nodeVersion: undefined }));
    assert.ok(issues.some((i) => i.message.includes("Node.js not found")));
  });

  it("detects old Node.js version", () => {
    const issues = detectIssues(makeBaseData({ nodeVersion: "v18.19.0" }));
    assert.ok(issues.some((i) => i.message.includes("20+ recommended")));
  });

  it("detects missing CLI", () => {
    const issues = detectIssues(makeBaseData({ cliVersion: undefined }));
    assert.ok(issues.some((i) => i.message.includes("@glubean/cli not found")));
  });

  it("detects scratch mode workspace", () => {
    const issues = detectIssues(
      makeBaseData({
        workspaceFolders: [
          {
            folderPath: "/Users/x/scratch",
            mode: "scratch",
            hasPackageJson: false,
            packageType: undefined,
            sdkVersion: undefined,
            envStatus: { exists: false, varCount: 0 },
            envSecretsStatus: { exists: false, varCount: 0 },
          },
        ],
      }),
    );
    assert.ok(issues.some((i) => i.message.includes("scratch mode")));
  });

  it("detects missing .env.secrets", () => {
    const issues = detectIssues(
      makeBaseData({
        workspaceFolders: [
          {
            folderPath: "/Users/x/project",
            mode: "project",
            hasPackageJson: true,
            packageType: "module",
            sdkVersion: "0.1.20",
            envStatus: { exists: true, varCount: 3 },
            envSecretsStatus: { exists: false, varCount: 0 },
          },
        ],
      }),
    );
    assert.ok(issues.some((i) => i.message.includes(".env.secrets not found")));
  });

  it("detects non-module package type", () => {
    const issues = detectIssues(
      makeBaseData({
        workspaceFolders: [
          {
            folderPath: "/Users/x/project",
            mode: "project",
            hasPackageJson: true,
            packageType: undefined,
            sdkVersion: "0.1.20",
            envStatus: { exists: true, varCount: 3 },
            envSecretsStatus: { exists: true, varCount: 1 },
          },
        ],
      }),
    );
    assert.ok(issues.some((i) => i.message.includes('"module" recommended')));
  });

  it("detects zero test files", () => {
    const issues = detectIssues(
      makeBaseData({
        discovery: { autoDiscover: true, layout: "auto", filesFound: 0, testItemCount: 0 },
      }),
    );
    assert.ok(issues.some((i) => i.message.includes("No .test.{ts,js,mjs} files")));
  });

  it("does not warn about zero files when autoDiscover is off", () => {
    const issues = detectIssues(
      makeBaseData({
        discovery: { autoDiscover: false, layout: "auto", filesFound: 0, testItemCount: 0 },
      }),
    );
    assert.ok(!issues.some((i) => i.message.includes("No .test.{ts,js,mjs} files")));
  });

  it("detects unrecognized current file", () => {
    const issues = detectIssues(
      makeBaseData({
        currentFile: {
          filePath: "/Users/x/project/utils.ts",
          fileName: "utils.ts",
          recognized: false,
          exports: [],
          pickExampleCount: 0,
          dataLoaderCount: 0,
        },
      }),
    );
    assert.ok(issues.some((i) => i.message.includes("not recognized")));
  });
});
