import * as path from "node:path";
import { normalizeFilterId } from "./testController.utils";

const SOURCE_EXT_RE = /\.(ts|js|mjs)$/;
const RESULT_EXT_RE = /\.result\.json$/;
const INVALID_PATH_SEGMENT_RE = /[<>:"/\\|?*]/g;

/**
 * Strip the source-file extension from a test file path.
 */
export function sourceBaseName(filePath: string): string {
  return path.basename(filePath).replace(SOURCE_EXT_RE, "");
}

/**
 * Strip `.result.json` from a result file path while preserving the source name.
 */
export function historyBaseName(filePath: string): string {
  return path.basename(filePath)
    .replace(SOURCE_EXT_RE, "")
    .replace(RESULT_EXT_RE, "");
}

/**
 * Sanitize a single filesystem path segment.
 */
export function sanitizePathSegment(value: string): string {
  return value.replace(INVALID_PATH_SEGMENT_RE, "_");
}

/**
 * Return the normalized key used to group result history for a test.
 *
 * Data-driven IDs are normalized to their filter prefix so `pick:` and `each:`
 * history stays grouped under the stable template key.
 */
export function resultHistoryKey(testId: string): string {
  return sanitizePathSegment(normalizeFilterId(testId));
}

/**
 * Return the root history directory for a test file.
 */
export function resultHistoryRoot(
  workspaceRoot: string,
  filePath: string,
): string {
  return path.join(workspaceRoot, ".glubean", "results", sourceBaseName(filePath));
}

/**
 * Return the history directory for a specific test key.
 */
export function resultHistoryDir(
  workspaceRoot: string,
  filePath: string,
  testId: string,
): string {
  return path.join(resultHistoryRoot(workspaceRoot, filePath), resultHistoryKey(testId));
}

/**
 * Build a history filename from a timestamp and optional pick label.
 *
 * Plain tests keep the historical `YYYYMMDDTHHMMSS.result.json` shape.
 * Pick runs append a readable suffix such as `[by-name]`.
 */
export function resultHistoryFileName(
  timestamp: string,
  pickLabel?: string,
): string {
  if (!pickLabel) {
    return `${timestamp}.result.json`;
  }
  return `${timestamp}[${sanitizePathSegment(pickLabel)}].result.json`;
}

/**
 * Extract a readable label from a history filename.
 *
 * Supports the current bracketed suffix and the older `--label` suffix used by
 * the previous implementation.
 */
export function extractHistoryLabel(fileName: string): string | undefined {
  const stem = fileName.replace(RESULT_EXT_RE, "");
  const bracketMatch = stem.match(/\[([^\]]+)\]$/);
  if (bracketMatch) {
    return bracketMatch[1];
  }

  const legacyIdx = stem.indexOf("--");
  if (legacyIdx >= 0) {
    return stem.slice(legacyIdx + 2);
  }

  return undefined;
}
