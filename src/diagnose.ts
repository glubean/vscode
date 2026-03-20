/**
 * Glubean: Diagnose command — collects runtime, project, discovery, and
 * current-file diagnostics and outputs a formatted report to an OutputChannel.
 *
 * Pure helper functions are exported for testing.
 */

import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { extractTests, isGlubeanFile } from "./parser";
import { extractPickExamples } from "@glubean/scanner/static";
import { findDataLoaderCalls } from "./dataLoaderCalls";
import { getAliases } from "./testController";
import { parseEnvContent } from "./envLoader";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Issue {
  level: "warn" | "error";
  message: string;
}

export interface DiagnosticData {
  nodeVersion: string | undefined;
  nodePath: string | undefined;
  vscodeVersion: string;
  extensionVersion: string;
  cliVersion: string | undefined;
  cliSource: "local" | "global" | undefined;
  workspaceFolders: WorkspaceDiag[];
  discovery: DiscoveryDiag;
  currentFile: CurrentFileDiag | undefined;
}

export interface WorkspaceDiag {
  folderPath: string;
  mode: "project" | "scratch";
  hasPackageJson: boolean;
  packageType: string | undefined;
  sdkVersion: string | undefined;
  envStatus: { exists: boolean; varCount: number };
  envSecretsStatus: { exists: boolean; varCount: number };
}

export interface DiscoveryDiag {
  autoDiscover: boolean;
  layout: string;
  filesFound: number;
  testItemCount: number;
}

export interface CurrentFileDiag {
  filePath: string;
  fileName: string;
  recognized: boolean;
  exports: Array<{ id: string; name: string; variant: string | undefined }>;
  pickExampleCount: number;
  dataLoaderCount: number;
}

// ---------------------------------------------------------------------------
// Pure helper functions (exported for testing)
// ---------------------------------------------------------------------------

export function formatVersion(
  version: string | undefined,
  nodePath?: string,
): string {
  if (!version) return "not found";
  if (nodePath) return `${version} (${nodePath})`;
  return version;
}

export function detectMode(hasNodeModulesSdk: boolean): "project" | "scratch" {
  return hasNodeModulesSdk ? "project" : "scratch";
}

export function countEnvVars(envContent: string): number {
  return Object.keys(parseEnvContent(envContent)).length;
}

export function formatIssues(issues: Issue[]): string {
  if (issues.length === 0) {
    return "  \u2713 No issues detected";
  }
  return issues.map((i) => `  - ${i.message}`).join("\n");
}

export function detectIssues(data: DiagnosticData): Issue[] {
  const issues: Issue[] = [];

  // Node.js checks
  if (!data.nodeVersion) {
    issues.push({ level: "error", message: "Node.js not found — required to run tests" });
  } else {
    const major = parseInt(data.nodeVersion.replace("v", ""), 10);
    if (major < 20) {
      issues.push({
        level: "warn",
        message: `Node.js version ${data.nodeVersion} detected, 20+ recommended`,
      });
    }
  }

  // CLI check
  if (!data.cliVersion) {
    issues.push({
      level: "warn",
      message: "@glubean/cli not found — run: npm install --save-dev @glubean/cli",
    });
  }

  // Per-workspace checks
  for (const ws of data.workspaceFolders) {
    if (ws.mode === "scratch") {
      issues.push({
        level: "warn",
        message: `${path.basename(ws.folderPath)}: scratch mode — no @glubean/sdk in node_modules`,
      });
    }
    if (ws.hasPackageJson && ws.packageType !== "module") {
      issues.push({
        level: "warn",
        message: `${path.basename(ws.folderPath)}: package.json "type" is "${ws.packageType ?? "commonjs"}", "module" recommended`,
      });
    }
    if (!ws.envSecretsStatus.exists) {
      issues.push({
        level: "warn",
        message: `${path.basename(ws.folderPath)}: .env.secrets not found — secrets will be undefined`,
      });
    }
  }

  // Discovery checks
  if (data.discovery.filesFound === 0 && data.discovery.autoDiscover) {
    issues.push({
      level: "warn",
      message: "No .test.{ts,js,mjs} files found in workspace",
    });
  }

  // Current file checks
  if (data.currentFile && !data.currentFile.recognized) {
    issues.push({
      level: "warn",
      message: `File "${data.currentFile.fileName}" not recognized — missing @glubean/sdk import`,
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Data collection (uses vscode API + filesystem)
// ---------------------------------------------------------------------------

function tryExec(cmd: string): string | undefined {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function readSdkVersion(folderPath: string): string | undefined {
  try {
    const pkgPath = path.join(folderPath, "node_modules", "@glubean", "sdk", "package.json");
    if (!fs.existsSync(pkgPath)) return undefined;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    return pkg.version;
  } catch {
    return undefined;
  }
}

function readCliVersion(folderPath: string): { version: string; source: "local" | "global" } | undefined {
  // Check local node_modules first
  try {
    const localPkgPath = path.join(folderPath, "node_modules", "@glubean", "cli", "package.json");
    if (fs.existsSync(localPkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(localPkgPath, "utf-8"));
      return { version: pkg.version, source: "local" };
    }
  } catch {
    // fall through
  }

  // Check global
  const output = tryExec("glubean --version");
  if (output) {
    const match = output.match(/(\d+\.\d+\.\d+)/);
    if (match) return { version: match[1], source: "global" };
  }

  return undefined;
}

function readEnvStatus(folderPath: string, fileName: string): { exists: boolean; varCount: number } {
  const filePath = path.join(folderPath, fileName);
  if (!fs.existsSync(filePath)) return { exists: false, varCount: 0 };
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return { exists: true, varCount: countEnvVars(content) };
  } catch {
    return { exists: true, varCount: 0 };
  }
}

function readPackageType(folderPath: string): { exists: boolean; type: string | undefined } {
  try {
    const pkgPath = path.join(folderPath, "package.json");
    if (!fs.existsSync(pkgPath)) return { exists: false, type: undefined };
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    return { exists: true, type: pkg.type };
  } catch {
    return { exists: false, type: undefined };
  }
}

async function collectDiagnosticData(): Promise<DiagnosticData> {
  // Runtime
  const nodeVersion = tryExec("node --version") ?? undefined;
  const nodePath = tryExec("which node") ?? tryExec("where node") ?? undefined;

  const vscodeVersion = vscode.version;
  const ext = vscode.extensions.getExtension("Glubean.glubean");
  const extensionVersion = ext?.packageJSON?.version ?? "unknown";

  // CLI — try first workspace folder
  const folders = vscode.workspace.workspaceFolders ?? [];
  const firstFolder = folders[0]?.uri.fsPath;
  const cli = firstFolder ? readCliVersion(firstFolder) : undefined;

  // Workspace folders
  const workspaceFolders: WorkspaceDiag[] = [];
  for (const folder of folders) {
    const fp = folder.uri.fsPath;
    const sdkVersion = readSdkVersion(fp);
    const pkg = readPackageType(fp);
    workspaceFolders.push({
      folderPath: fp,
      mode: detectMode(!!sdkVersion),
      hasPackageJson: pkg.exists,
      packageType: pkg.type,
      sdkVersion,
      envStatus: readEnvStatus(fp, ".env"),
      envSecretsStatus: readEnvStatus(fp, ".env.secrets"),
    });
  }

  // Discovery
  const config = vscode.workspace.getConfiguration("glubean");
  const autoDiscover = config.get<boolean>("autoDiscover", true);
  const layout = config.get<string>("testExplorerLayout", "auto");

  let filesFound = 0;
  try {
    const testFiles = await vscode.workspace.findFiles(
      "**/*.test.{ts,js,mjs}",
      "**/node_modules/**",
    );
    filesFound = testFiles.length;
  } catch {
    // ignore
  }

  // We cannot directly access the test controller's items from here,
  // so filesFound serves as the primary discovery metric.
  const testItemCount = 0;

  // Current file
  let currentFile: CurrentFileDiag | undefined;
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const filePath = editor.document.uri.fsPath;
    const fileName = path.basename(filePath);
    const content = editor.document.getText();
    const aliases = getAliases();
    const recognized = isGlubeanFile(content, aliases);

    const exports = recognized
      ? extractTests(content, aliases).map((t) => ({
          id: t.id,
          name: t.name ?? t.id,
          variant: t.id.includes(":") ? t.id.split(":")[0] : undefined,
        }))
      : [];

    let pickExampleCount = 0;
    try {
      const pickMetas = extractPickExamples(content, { customFns: aliases });
      pickExampleCount = pickMetas.length;
    } catch {
      // ignore
    }

    const workspaceRoot =
      vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.fsPath ??
      path.dirname(filePath);
    let dataLoaderCount = 0;
    try {
      const calls = findDataLoaderCalls(content, { filePath, workspaceRoot });
      dataLoaderCount = calls.length;
    } catch {
      // ignore
    }

    currentFile = {
      filePath,
      fileName,
      recognized,
      exports,
      pickExampleCount,
      dataLoaderCount,
    };
  }

  return {
    nodeVersion,
    nodePath,
    vscodeVersion,
    extensionVersion,
    cliVersion: cli?.version,
    cliSource: cli?.source,
    workspaceFolders,
    discovery: { autoDiscover, layout, filesFound, testItemCount },
    currentFile,
  };
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

const SEPARATOR = "\u2550".repeat(43);

function formatReport(data: DiagnosticData, issues: Issue[]): string {
  const lines: string[] = [];

  lines.push(SEPARATOR);
  lines.push("  Glubean Diagnostics");
  lines.push(SEPARATOR);
  lines.push("");

  // Runtime
  lines.push("Runtime");
  lines.push(`  Node.js:     ${formatVersion(data.nodeVersion, data.nodePath ?? undefined)}`);
  lines.push(`  VSCode:      ${data.vscodeVersion}`);
  lines.push(`  Extension:   ${data.extensionVersion}`);
  if (data.cliVersion) {
    lines.push(`  CLI:         ${data.cliVersion} (${data.cliSource})`);
  } else {
    lines.push("  CLI:         not found");
  }
  lines.push("");

  // Workspace folders
  for (const ws of data.workspaceFolders) {
    lines.push(`Workspace: ${ws.folderPath}`);
    lines.push(`  Mode:        ${ws.mode}`);
    if (ws.sdkVersion) {
      lines.push(`  SDK:         @glubean/sdk@${ws.sdkVersion}`);
    } else {
      lines.push("  SDK:         not installed");
    }
    if (ws.hasPackageJson) {
      lines.push(`  package.json: \u2713 (type: "${ws.packageType ?? "commonjs"}")`);
    } else {
      lines.push("  package.json: not found");
    }

    const envMark = ws.envStatus.exists ? `\u2713 (${ws.envStatus.varCount} vars)` : "not found";
    lines.push(`  .env:        ${envMark}`);

    const secretsMark = ws.envSecretsStatus.exists
      ? `\u2713 (${ws.envSecretsStatus.varCount} secrets)`
      : "not found";
    lines.push(`  .env.secrets: ${secretsMark}`);
    lines.push("");
  }

  if (data.workspaceFolders.length === 0) {
    lines.push("Workspace: (none)");
    lines.push("");
  }

  // Discovery
  lines.push("Test Discovery");
  lines.push(`  Auto-discover: ${data.discovery.autoDiscover ? "enabled" : "disabled"}`);
  lines.push(`  Layout:        ${data.discovery.layout}`);
  lines.push(`  Files found:   ${data.discovery.filesFound}`);
  lines.push("");

  // Current file
  if (data.currentFile) {
    lines.push(`Current File: ${data.currentFile.fileName}`);
    lines.push(`  Recognized:  ${data.currentFile.recognized ? "\u2713 (SDK import detected)" : "\u2717"}`);
    lines.push(`  Exports:     ${data.currentFile.exports.length} tests`);
    for (const exp of data.currentFile.exports) {
      const variant = exp.variant ? ` (${exp.variant})` : "";
      lines.push(`    - ${exp.name}${variant}`);
    }
    if (data.currentFile.pickExampleCount > 0) {
      lines.push(`  Pick tests:  ${data.currentFile.pickExampleCount}`);
    }
    if (data.currentFile.dataLoaderCount > 0) {
      lines.push(`  Data loaders: ${data.currentFile.dataLoaderCount}`);
    }
    lines.push("");
  }

  // Issues
  lines.push(SEPARATOR);
  if (issues.length === 0) {
    lines.push("  \u2713 No issues detected");
  } else {
    lines.push("  \u26A0 Issues");
    for (const issue of issues) {
      lines.push(`  - ${issue.message}`);
    }
  }
  lines.push(SEPARATOR);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runDiagnose(
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  outputChannel.appendLine("");
  outputChannel.appendLine("Running diagnostics...");
  outputChannel.appendLine("");

  const data = await collectDiagnosticData();
  const issues = detectIssues(data);
  const report = formatReport(data, issues);

  outputChannel.appendLine(report);
}
