/**
 * Anonymous opt-in telemetry for the Glubean VS Code extension.
 *
 * Telemetry is disabled by default. Users are prompted once, after their first
 * successful test run. The setting can be toggled at any time via:
 *   VS Code Settings → Glubean › Telemetry: Enabled
 *
 * What is collected: structured usage events (run counts, feature usage,
 * error types). What is never collected: file paths, test names, URLs,
 * request/response content, or any personally identifiable information.
 *
 * Full transparency doc: https://github.com/glubean/vscode/blob/main/docs/telemetry.md
 */

import * as vscode from "vscode";
import { PostHog } from "posthog-node";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TELEMETRY_DOC_URL =
  "https://github.com/glubean/vscode/blob/main/docs/telemetry.md";

/**
 * PostHog project write key. This key is intentionally public — it only allows
 * writing anonymous events, not reading data. See docs/telemetry.md for details.
 */
const POSTHOG_WRITE_KEY = "phc_YOUR_WRITE_KEY_HERE";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let client: PostHog | null = null;
let extensionContext: vscode.ExtensionContext | undefined;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the telemetry module. Call once from `activate()`.
 *
 * Reads the current `glubean.telemetry.enabled` setting, creates or tears down
 * the PostHog client accordingly, and subscribes to future config changes.
 */
export function initTelemetry(context: vscode.ExtensionContext): void {
  extensionContext = context;
  rebuildClient();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("glubean.telemetry.enabled") ||
        e.affectsConfiguration("telemetry.telemetryLevel")
      ) {
        rebuildClient();
      }
    }),
  );
}

/**
 * Send a named event with optional structured properties.
 *
 * No-op when telemetry is disabled or the PostHog client is not initialized.
 * Properties must not contain file paths, test names, URLs, error messages,
 * or any personally identifiable information.
 */
export function track(
  event: string,
  props?: Record<string, string | number | boolean | undefined>,
): void {
  if (!client) return;

  client.capture({
    distinctId: vscode.env.machineId,
    event,
    properties: {
      ...props,
      os: process.platform,
      vscode_version: vscode.version,
      extension_version: getExtensionVersion(),
    },
  });
}

/**
 * Flush pending events and tear down the PostHog client.
 * Call from `deactivate()`.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (client) {
    await client.shutdown();
    client = null;
  }
}

/**
 * Show the one-time telemetry consent prompt, if the user has not yet been asked.
 *
 * Triggered after the first successful test run so the user has already
 * experienced value before being prompted. If the user clicks "Learn more",
 * the telemetry doc opens in a browser. Either way, the prompt is never shown
 * again — the user can change their mind via Settings at any time.
 */
export async function maybeAskConsent(
  context: vscode.ExtensionContext,
): Promise<void> {
  const asked = context.globalState.get<boolean>("telemetry.asked", false);
  if (asked) return;

  // Mark as asked immediately so concurrent runs don't show the prompt twice.
  await context.globalState.update("telemetry.asked", true);

  const choice = await vscode.window.showInformationMessage(
    "Enjoying Glubean? Help us improve it — share anonymous usage stats (run counts, errors, feature usage). No code, paths, or personal data. Ever.",
    "Yes, I'd like to help",
    "No thanks",
    "Learn more",
  );

  if (choice === "Learn more") {
    await vscode.env.openExternal(vscode.Uri.parse(TELEMETRY_DOC_URL));
    return;
  }

  if (choice === "Yes, I'd like to help") {
    await vscode.workspace
      .getConfiguration("glubean")
      .update("telemetry.enabled", true, vscode.ConfigurationTarget.Global);
    rebuildClient();
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isTelemetryEnabled(): boolean {
  const setting = vscode.workspace
    .getConfiguration("glubean")
    .get<boolean>("telemetry.enabled", false);
  return setting && vscode.env.isTelemetryEnabled;
}

function rebuildClient(): void {
  if (client) {
    void client.shutdown();
    client = null;
  }

  if (isTelemetryEnabled()) {
    client = new PostHog(POSTHOG_WRITE_KEY, {
      host: "https://app.posthog.com",
      flushAt: 5,
      flushInterval: 10_000,
    });
  }
}

function getExtensionVersion(): string {
  try {
    return (
      vscode.extensions.getExtension("glubean.glubean")?.packageJSON
        ?.version ?? "unknown"
    );
  } catch {
    return "unknown";
  }
}
