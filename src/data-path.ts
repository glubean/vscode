import { dirname, isAbsolute, resolve } from "path";

export type DataPathMode = "file" | "project" | "absolute";

export interface ResolveDataPathOptions {
  sourceFilePath: string;
  workspaceRoot: string;
}

export interface ResolvedDataPath {
  mode: DataPathMode;
  resolvedPath: string;
}

export function classifyDataPath(rawPath: string): DataPathMode {
  if (isAbsolute(rawPath)) return "absolute";
  if (rawPath.startsWith("./") || rawPath.startsWith("../")) return "file";
  return "project";
}

function preserveTrailingSlash(rawPath: string, resolvedPath: string): string {
  if (rawPath.endsWith("/") && !resolvedPath.endsWith("/")) {
    return `${resolvedPath}/`;
  }
  return resolvedPath;
}

export function resolveDataPath(
  rawPath: string,
  options: ResolveDataPathOptions,
): ResolvedDataPath {
  const mode = classifyDataPath(rawPath);

  if (mode === "absolute") {
    return { mode, resolvedPath: preserveTrailingSlash(rawPath, rawPath) };
  }

  if (mode === "file") {
    return {
      mode,
      resolvedPath: preserveTrailingSlash(
        rawPath,
        resolve(dirname(options.sourceFilePath), rawPath),
      ),
    };
  }

  return {
    mode,
    resolvedPath: preserveTrailingSlash(
      rawPath,
      resolve(options.workspaceRoot, rawPath),
    ),
  };
}
