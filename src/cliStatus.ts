import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";

const CACHE_KEY = "glubean.cliLatestVersion";
const CACHE_TS_KEY = "glubean.cliLatestCheckedAt";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const REGISTRY_URL = "https://registry.npmjs.org/glubean/latest";

let statusBarItem: vscode.StatusBarItem;
let currentAction: "install" | "upgrade" | "none" = "none";
let glubeanFolders = new Set<string>();

// ── Semver helpers (from CLI update_check.ts) ────────────────────────────────

function parseSemver(
  version: string,
): { major: number; minor: number; patch: number } | undefined {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return undefined;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

function isNewer(latest: string, current: string): boolean {
  const l = parseSemver(latest);
  const c = parseSemver(current);
  if (!l || !c) return false;
  if (l.major !== c.major) return l.major > c.major;
  if (l.minor !== c.minor) return l.minor > c.minor;
  return l.patch > c.patch;
}

// ── Detection ────────────────────────────────────────────────────────────────

function isGlubeanProject(folderPath: string): boolean {
  try {
    const pkgPath = path.join(folderPath, "package.json");
    if (!fs.existsSync(pkgPath)) return false;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return "@glubean/sdk" in deps;
  } catch {
    return false;
  }
}

function getInstalledCliVersion(folderPath: string): string | undefined {
  // Check local node_modules first
  try {
    const localPkgPath = path.join(
      folderPath,
      "node_modules",
      "@glubean",
      "cli",
      "package.json",
    );
    if (fs.existsSync(localPkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(localPkgPath, "utf-8"));
      return pkg.version;
    }
  } catch {
    // fall through to global check
  }

  // Check global — resolve from the glubean bin
  try {
    const { execSync } = require("node:child_process");
    const output = execSync("glubean --version", {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // Output format: "glubean/0.1.12" or just "0.1.12"
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

// ── Registry ─────────────────────────────────────────────────────────────────

async function fetchLatestVersion(
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  const cachedAt = context.globalState.get<number>(CACHE_TS_KEY) ?? 0;
  const cachedVersion = context.globalState.get<string>(CACHE_KEY);
  if (Date.now() - cachedAt < CHECK_INTERVAL_MS && cachedVersion) {
    return cachedVersion;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(REGISTRY_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return cachedVersion;
    const data = (await res.json()) as { version?: string };
    const version = data.version;
    if (version) {
      await context.globalState.update(CACHE_KEY, version);
      await context.globalState.update(CACHE_TS_KEY, Date.now());
    }
    return version ?? cachedVersion;
  } catch {
    return cachedVersion;
  }
}

// ── Status Bar ───────────────────────────────────────────────────────────────

function updateStatusBar(
  installedVersion: string | undefined,
  latestVersion: string | undefined,
): void {
  if (!installedVersion) {
    statusBarItem.text = "$(alert) Glubean CLI";
    statusBarItem.tooltip =
      "Glubean CLI is not installed. Click to install.";
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
    currentAction = "install";
    statusBarItem.show();
    return;
  }

  if (latestVersion && isNewer(latestVersion, installedVersion)) {
    statusBarItem.text = `$(arrow-up) CLI ${installedVersion} → ${latestVersion}`;
    statusBarItem.tooltip = `Glubean CLI update available. Click to upgrade.`;
    statusBarItem.backgroundColor = undefined;
    currentAction = "upgrade";
    statusBarItem.show();
    return;
  }

  statusBarItem.text = `$(check) CLI ${installedVersion}`;
  statusBarItem.tooltip = "Glubean CLI is up to date";
  statusBarItem.backgroundColor = undefined;
  currentAction = "none";
  statusBarItem.show();
}

async function updateForFolder(
  folderPath: string | undefined,
  context: vscode.ExtensionContext,
): Promise<void> {
  if (!folderPath || !glubeanFolders.has(folderPath)) {
    statusBarItem.hide();
    return;
  }

  const installed = getInstalledCliVersion(folderPath);
  const latest = await fetchLatestVersion(context);
  updateStatusBar(installed, latest);
}

// ── Activation ───────────────────────────────────────────────────────────────

function scanWorkspaceFolders(): void {
  glubeanFolders.clear();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (isGlubeanProject(folder.uri.fsPath)) {
      glubeanFolders.add(folder.uri.fsPath);
    }
  }
}

function getActiveFolderPath(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) return folder.uri.fsPath;
  }
  const folders = vscode.workspace.workspaceFolders;
  if (folders?.length === 1) return folders[0].uri.fsPath;
  return undefined;
}

export function activateCliStatus(
  context: vscode.ExtensionContext,
): void {
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99,
  );
  statusBarItem.command = "glubean.cliAction";
  context.subscriptions.push(statusBarItem);

  // Register click command — install/upgrade locally
  context.subscriptions.push(
    vscode.commands.registerCommand("glubean.cliAction", () => {
      if (currentAction === "none") {
        vscode.window.showInformationMessage("Glubean CLI is up to date.");
        return;
      }

      const cmd =
        currentAction === "install"
          ? "npm install -g glubean"
          : "npm install -g glubean@latest";

      const terminal =
        vscode.window.activeTerminal ??
        vscode.window.createTerminal("Glubean");
      terminal.show();
      terminal.sendText(cmd);
    }),
  );

  // Initial scan
  scanWorkspaceFolders();

  // Update on active editor change
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      void updateForFolder(getActiveFolderPath(), context);
    }),
  );

  // Re-scan on workspace folder changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      scanWorkspaceFolders();
      void updateForFolder(getActiveFolderPath(), context);
    }),
  );

  // Watch for CLI package changes (install/upgrade/remove)
  const cliWatcher = vscode.workspace.createFileSystemWatcher(
    "**/node_modules/@glubean/cli/package.json",
  );
  const onCliChange = () => {
    scanWorkspaceFolders();
    void updateForFolder(getActiveFolderPath(), context);
  };
  cliWatcher.onDidCreate(onCliChange);
  cliWatcher.onDidChange(onCliChange);
  cliWatcher.onDidDelete(onCliChange);
  context.subscriptions.push(cliWatcher);

  // Also watch for SDK dependency changes (project becomes/stops being glubean project)
  const pkgWatcher = vscode.workspace.createFileSystemWatcher(
    "**/package.json",
  );
  const onPkgChange = () => {
    scanWorkspaceFolders();
    void updateForFolder(getActiveFolderPath(), context);
  };
  pkgWatcher.onDidChange(onPkgChange);
  context.subscriptions.push(pkgWatcher);

  // Initial update (async, non-blocking)
  void updateForFolder(getActiveFolderPath(), context);
}
