import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import { resolveDataPath } from "./data-path";
import {
  forEachExportedConst,
  parseSource,
  propertyNameText,
  stringFromExpression as astStringFromExpression,
  unwrapExpression as astUnwrap,
  walk,
  type AnyNode,
  type SourceFile,
} from "./ast";
import type { TestMeta } from "./parser";

export interface DataDrivenRow {
  kind: "each" | "pick";
  parentId: string;
  id: string;
  label: string;
  exportName: string;
  pickKey?: string;
}

export interface MaterializedDataDrivenRows {
  rowsByParentId: Map<string, DataDrivenRow[]>;
  dataPaths: string[];
  /**
   * Subset of `dataPaths` that are directory roots (from `fromDir(...)` loaders).
   * Separated so `testController` can use the correct watcher matching strategy:
   * `sameDir` for concrete files, `insideDir` for directory roots. Using
   * `path.extname` to infer kind is unreliable for dirs with a dot in the name
   * (e.g. `./data.v1/`).
   */
  dataDirRoots: string[];
  /**
   * Diagnostics surfaced during materialisation — used by `testController`
   * to render gentle warnings (status-bar / file-level marker) when a
   * data file is malformed, exceeds the row cap, or otherwise can't be
   * fully turned into TestItems. Pre-fix these failures were silent —
   * the test row simply didn't appear and the user had no signal.
   */
  diagnostics: DataRowDiagnostic[];
}

export interface DataRowDiagnostic {
  /** Test export the diagnostic relates to — e.g. `csvCases`. */
  exportName: string;
  /** Severity. `warning` = degraded (row cap hit, parse error), `info` = informational. */
  severity: "warning" | "info";
  /** Short human-readable message ready to surface in a notification or status bar. */
  message: string;
  /** Optional path of the data file that triggered the diagnostic. */
  dataPath?: string;
}

/**
 * Hard cap on rows materialised per data-driven export. 100k-row CSVs
 * would otherwise create 100k VSCode TestItems and freeze the Test
 * Explorer. 5000 was picked as a practical ceiling — large enough for
 * realistic API parameter sweeps, small enough for VSCode to render
 * the tree without lag. Authors hitting the cap see an `info` diagnostic
 * suggesting they `--filter` to a subset.
 */
export const ROW_CAP = 5000;

interface RowData {
  index: number;
  pickKey?: string;
  data: Record<string, unknown>;
}

type SourceRef =
  | { kind: "inline"; value: unknown }
  | { kind: "json-import"; rawPath: string }
  | { kind: "csv"; rawPath: string; separator?: string; headers?: boolean }
  | { kind: "json"; rawPath: string; pick?: string; map?: boolean }
  | { kind: "yaml"; rawPath: string; pick?: string; map?: boolean }
  | { kind: "jsonl"; rawPath: string }
  | {
      kind: "dir";
      rawPath: string;
      mode: "dir" | "concat" | "merge";
      ext?: string[];
      recursive?: boolean;
      pick?: string;
    };

interface DataCall {
  kind: "each" | "pick";
  dataArg: AnyNode;
}

interface AstIndex {
  source: SourceFile;
  jsonImports: Map<string, string>;
  bindings: Map<string, AnyNode>;
  dataCallsByExport: Map<string, DataCall>;
}

const UNREADABLE = Symbol("unreadable");

export function materializeDataDrivenRows(
  content: string,
  tests: TestMeta[],
  options: { filePath: string; workspaceRoot: string },
): MaterializedDataDrivenRows {
  const rowsByParentId = new Map<string, DataDrivenRow[]>();
  const dataPaths = new Set<string>();
  const dataDirRoots = new Set<string>();
  const diagnostics: DataRowDiagnostic[] = [];
  const index = buildAstIndex(content, options.filePath);
  if (!index) return { rowsByParentId, dataPaths: [], dataDirRoots: [], diagnostics };

  for (const test of tests) {
    const kind = test.id.startsWith("each:")
      ? "each"
      : test.id.startsWith("pick:")
        ? "pick"
        : undefined;
    if (!kind) continue;

    const call = index.dataCallsByExport.get(test.exportName);
    if (!call || call.kind !== kind) continue;

    const source = sourceRefFromExpression(call.dataArg, index);
    if (!source) continue;

    const resolved = readRows(source, kind, options);
    for (const dataPath of resolved.dataPaths) dataPaths.add(dataPath);
    if (resolved.dirRoot) dataDirRoots.add(resolved.dirRoot);

    // Surface read-time errors (parse failure, missing file, malformed
    // YAML, etc) as a warning so the user sees WHY rows didn't appear.
    if (resolved.error) {
      diagnostics.push({
        exportName: test.exportName,
        severity: "warning",
        message: resolved.error,
        dataPath: resolved.dataPaths[0],
      });
      continue;
    }

    if (resolved.rows.length === 0) {
      // Successfully read but the file was empty / picked path resolved
      // to nothing. Distinct from `error` — the user's setup is correct,
      // just the data is empty.
      if (resolved.dataPaths.length > 0) {
        diagnostics.push({
          exportName: test.exportName,
          severity: "info",
          message: `${test.exportName}: data file produced 0 rows.`,
          dataPath: resolved.dataPaths[0],
        });
      }
      continue;
    }

    // Hard cap so a malformed (or just very large) data source can't
    // freeze the Test Explorer. We materialise the first `ROW_CAP` rows
    // and emit an `info` diagnostic with the truncated count.
    let truncated = false;
    let scannedRows = resolved.rows;
    if (scannedRows.length > ROW_CAP) {
      truncated = true;
      scannedRows = scannedRows.slice(0, ROW_CAP);
    }

    const templateId = stripDataPrefix(test.id);
    const labelTemplate = stripDataSuffix(test.name ?? templateId);
    const rows: DataDrivenRow[] = [];

    for (const row of scannedRows) {
      const id = interpolateTemplate(templateId, row.data, row.index);
      if (hasUnresolvedTemplate(id)) continue;

      const label = interpolateTemplate(labelTemplate, row.data, row.index);
      rows.push({
        kind,
        parentId: test.id,
        id,
        label: label && !hasUnresolvedTemplate(label) ? label : id,
        exportName: test.exportName,
        ...(row.pickKey !== undefined ? { pickKey: row.pickKey } : {}),
      });
    }

    if (truncated) {
      diagnostics.push({
        exportName: test.exportName,
        severity: "info",
        message: `${test.exportName}: data source has ${resolved.rows.length} rows; only the first ${ROW_CAP} are materialised in the Test Explorer. Use --filter to run others.`,
        dataPath: resolved.dataPaths[0],
      });
    }

    if (rows.length > 0) {
      rowsByParentId.set(test.id, rows);
    }
  }

  return { rowsByParentId, dataPaths: [...dataPaths].sort(), dataDirRoots: [...dataDirRoots], diagnostics };
}

function buildAstIndex(content: string, filePath: string): AstIndex | undefined {
  let source: SourceFile;
  try {
    source = parseSource(content, filePath);
  } catch {
    // Acorn throws on syntax errors. Treat unparseable as "no rows" — the
    // user is editing and the AST will rebuild on next save.
    return undefined;
  }

  const index: AstIndex = {
    source,
    jsonImports: new Map(),
    bindings: new Map(),
    dataCallsByExport: new Map(),
  };

  // Walk top-level statements only — bindings declared inside functions
  // can't be referenced by an exported `test.each(value)`, so the
  // restriction matches what's actually resolvable.
  for (const statement of source.program.body) {
    if (statement.type === "ImportDeclaration") {
      // `import data from "./x.json"` — capture the local binding name
      // so `test.each(data)` can resolve to the JSON file path.
      const specifiers = (statement as AnyNode).specifiers as AnyNode[] | undefined;
      const sourceNode = (statement as AnyNode).source as AnyNode | undefined;
      const modulePath = sourceNode ? astStringFromExpression(sourceNode) : undefined;
      if (modulePath?.endsWith(".json") && specifiers) {
        for (const specifier of specifiers) {
          if (specifier.type !== "ImportDefaultSpecifier") continue;
          const local = (specifier as AnyNode).local as AnyNode;
          if (local.type === "Identifier") {
            index.jsonImports.set(local.name as string, modulePath);
          }
        }
      }
      continue;
    }

    // Capture bindings declared by ANY top-level `const x = ...`. Both
    // `export const` and bare `const` are valid sources for the
    // identifier-based resolution path. `let`/`var` are intentionally
    // skipped — those imply reassignment and we can't trust the static
    // initializer to match the runtime value.
    const declarationNode = pickVariableDeclaration(statement);
    if (declarationNode) {
      const declarators = (declarationNode as AnyNode).declarations as AnyNode[] | undefined;
      if (!declarators) continue;
      for (const declarator of declarators) {
        const id = (declarator as AnyNode).id as AnyNode | undefined;
        const init = (declarator as AnyNode).init as AnyNode | undefined;
        if (!id || id.type !== "Identifier" || !init) continue;
        index.bindings.set((id as AnyNode).name as string, init);
      }
    }
  }

  // Now find exported data-driven exports (`export const X = test.each(...)`).
  forEachExportedConst(source, (_statement, declarator) => {
    const id = (declarator as AnyNode).id as AnyNode | undefined;
    const init = (declarator as AnyNode).init as AnyNode | undefined;
    if (!id || id.type !== "Identifier" || !init) return;

    const dataCall = findDataCall(init);
    if (dataCall) index.dataCallsByExport.set((id as AnyNode).name as string, dataCall);
  });

  return index;
}

/**
 * Return the `VariableDeclaration` node carried by a top-level statement,
 * regardless of whether it's exported. Handles plain `const x = …` and
 * `export const x = …`.
 */
function pickVariableDeclaration(statement: AnyNode): AnyNode | undefined {
  if (statement.type === "VariableDeclaration") return statement;
  if (statement.type === "ExportNamedDeclaration") {
    const inner = (statement as AnyNode).declaration as AnyNode | undefined;
    if (inner?.type === "VariableDeclaration") return inner;
  }
  return undefined;
}

/**
 * Walk an expression looking for the outermost `.each(...)` / `.pick(...)`
 * call. Returns `{ kind, dataArg }` — `dataArg` is the first argument,
 * which is what we'll resolve to a SourceRef.
 *
 * The walker stops at the first match (outermost) so chains like
 * `test.each(await fromCsv(path))` yield `{ kind: "each", dataArg: <await> }`.
 */
function findDataCall(expr: AnyNode): DataCall | undefined {
  // Walk only the callee chain — never descend into arguments or callback
  // bodies. This prevents a nested `.each()` inside a test callback from
  // shadowing the real data source call on the callee side.
  //
  // Handles both forms:
  //   test.each(cases)               — direct: init IS the data call
  //   test.each(cases)(desc, async() => { … helper.each(…) … })
  //                                  — curried: data call is the callee
  let current = unwrapCallee(expr);
  while (current.type === "CallExpression") {
    const callee = unwrapCallee((current as AnyNode).callee as AnyNode);
    if (callee.type === "MemberExpression") {
      const property = (callee as AnyNode).property as AnyNode;
      if (property.type === "Identifier") {
        const name = (property as AnyNode).name as string;
        if (name === "each" || name === "pick") {
          const args = (current as AnyNode).arguments as AnyNode[] | undefined;
          if (args && args.length > 0) {
            return { kind: name as "each" | "pick", dataArg: args[0]! };
          }
        }
      }
    }
    current = unwrapCallee((current as AnyNode).callee as AnyNode);
  }
  return undefined;
}

function sourceRefFromExpression(
  expression: AnyNode,
  index: AstIndex,
  visited = new Set<string>(),
): SourceRef | undefined {
  const expr = unwrapAll(expression);
  if (!expr) return undefined;

  if (expr.type === "Identifier") {
    const ident = (expr as AnyNode).name as string;
    const jsonPath = index.jsonImports.get(ident);
    if (jsonPath) return { kind: "json-import", rawPath: jsonPath };

    if (visited.has(ident)) return undefined;
    const bound = index.bindings.get(ident);
    if (!bound) return undefined;

    visited.add(ident);
    return sourceRefFromExpression(bound, index, visited);
  }

  if (expr.type === "ArrayExpression" || expr.type === "ObjectExpression") {
    const value = literalValue(expr);
    return value === UNREADABLE ? undefined : { kind: "inline", value };
  }

  if (expr.type === "CallExpression") {
    return loaderSourceRef(expr);
  }

  return undefined;
}

function loaderSourceRef(call: AnyNode): SourceRef | undefined {
  const callee = unwrapAll((call as AnyNode).callee as AnyNode);
  const name = callee ? loaderName(callee) : undefined;
  if (!name) return undefined;

  const args = (call as AnyNode).arguments as AnyNode[] | undefined;
  if (!args || args.length === 0) return undefined;
  const rawPath = astStringFromExpression(args[0]);
  if (!rawPath) return undefined;

  const options = objectOptions(args[1]);

  switch (name) {
    case "fromCsv":
      return {
        kind: "csv",
        rawPath,
        separator: options.separator,
        headers: options.headers,
      };
    case "fromJsonl":
      return { kind: "jsonl", rawPath };
    case "fromJson":
      return { kind: "json", rawPath, pick: options.pick };
    case "fromJson.map":
      return { kind: "json", rawPath, map: true };
    case "fromYaml":
      return { kind: "yaml", rawPath, pick: options.pick };
    case "fromYaml.map":
      return { kind: "yaml", rawPath, map: true };
    case "fromDir":
      return {
        kind: "dir",
        rawPath,
        mode: "dir",
        ext: options.ext,
        recursive: options.recursive,
      };
    case "fromDir.concat":
      return {
        kind: "dir",
        rawPath,
        mode: "concat",
        ext: options.ext,
        recursive: options.recursive,
        pick: options.pick,
      };
    case "fromDir.merge":
      return {
        kind: "dir",
        rawPath,
        mode: "merge",
        ext: options.ext,
        recursive: options.recursive,
      };
  }
}

function loaderName(callee: AnyNode): string | undefined {
  if (callee.type === "Identifier") {
    const text = (callee as AnyNode).name as string;
    return ["fromCsv", "fromJson", "fromJsonl", "fromYaml", "fromDir"].includes(text)
      ? text
      : undefined;
  }

  if (callee.type === "MemberExpression") {
    const object = (callee as AnyNode).object as AnyNode;
    const property = (callee as AnyNode).property as AnyNode;
    if (object.type !== "Identifier" || property.type !== "Identifier") return undefined;
    const base = (object as AnyNode).name as string;
    const prop = (property as AnyNode).name as string;
    const name = `${base}.${prop}`;
    return ["fromJson.map", "fromYaml.map", "fromDir.concat", "fromDir.merge"].includes(name)
      ? name
      : undefined;
  }

  return undefined;
}

function objectOptions(expression: AnyNode | undefined): {
  pick?: string;
  separator?: string;
  headers?: boolean;
  ext?: string[];
  recursive?: boolean;
} {
  const expr = expression ? unwrapAll(expression) : undefined;
  if (!expr || expr.type !== "ObjectExpression") return {};

  const out: ReturnType<typeof objectOptions> = {};
  const properties = (expr as AnyNode).properties as AnyNode[] | undefined;
  if (!properties) return out;

  for (const property of properties) {
    if (property.type !== "Property") continue;
    const key = propertyNameText(property);
    if (!key) continue;
    const value = (property as AnyNode).value as AnyNode | undefined;
    if (!value) continue;

    if (key === "pick") {
      const pick = astStringFromExpression(value);
      if (pick) out.pick = pick;
    } else if (key === "separator") {
      const separator = astStringFromExpression(value);
      if (separator) out.separator = separator;
    } else if (key === "headers") {
      const v = booleanFromExpression(value);
      if (v !== undefined) out.headers = v;
    } else if (key === "recursive") {
      const v = booleanFromExpression(value);
      if (v !== undefined) out.recursive = v;
    } else if (key === "ext") {
      const v = stringArrayFromExpression(value);
      if (v.length > 0) out.ext = v;
    }
  }

  return out;
}

interface ReadRowsResult {
  rows: RowData[];
  dataPaths: string[];
  /** Set for `dir` loaders: the resolved directory root (first element of `dataPaths`). */
  dirRoot?: string;
  /** Populated when the data source could not be read or parsed. Surfaces as a `warning` diagnostic. */
  error?: string;
}

function readRows(
  source: SourceRef,
  kind: "each" | "pick",
  options: { filePath: string; workspaceRoot: string },
): ReadRowsResult {
  try {
    switch (source.kind) {
      case "inline":
        return { rows: rowsFromValue(source.value, kind), dataPaths: [] };
      case "json-import": {
        const filePath = resolveLoaderPath(source.rawPath, options);
        return {
          rows: rowsFromValue(JSON.parse(fs.readFileSync(filePath, "utf-8")), kind),
          dataPaths: [filePath],
        };
      }
      case "csv": {
        const filePath = resolveLoaderPath(source.rawPath, options);
        const rows = parseCsv(fs.readFileSync(filePath, "utf-8"), {
          separator: source.separator,
          headers: source.headers,
        });
        return { rows: rowsFromValue(rows, kind), dataPaths: [filePath] };
      }
      case "json": {
        const filePath = resolveLoaderPath(source.rawPath, options);
        const value = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        const picked = source.map ? value : pickByPath(value, source.pick);
        return { rows: rowsFromValue(picked, kind), dataPaths: [filePath] };
      }
      case "yaml": {
        const filePath = resolveLoaderPath(source.rawPath, options);
        const value = parseYaml(fs.readFileSync(filePath, "utf-8"));
        const picked = source.map ? value : pickByPath(value, source.pick);
        return { rows: rowsFromValue(picked, kind), dataPaths: [filePath] };
      }
      case "jsonl": {
        const filePath = resolveLoaderPath(source.rawPath, options);
        const rows = fs
          .readFileSync(filePath, "utf-8")
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line));
        return { rows: rowsFromValue(rows, kind), dataPaths: [filePath] };
      }
      case "dir":
        return readDirRows(source, kind, options);
    }
  } catch (error) {
    // Surface the failure to the diagnostics pipeline. Most common
    // cases: file not found, JSON.parse SyntaxError, malformed YAML.
    //
    // Crucially: resolve the path even on failure so the watcher dependency
    // is registered. Without this, fixing a malformed file would not trigger
    // a re-parse because the test controller never learned which data file
    // was involved. resolveLoaderPath is a pure path computation; it won't
    // throw for a missing file.
    const message = error instanceof Error ? error.message : String(error);
    let failedPaths: string[] = [];
    let failedDirRoot: string | undefined;
    if (source.kind !== "inline") {
      try {
        const resolved = resolveLoaderPath(source.rawPath, options);
        failedPaths = [resolved];
        // For dir loaders: propagate dirRoot even on failure so the watcher
        // dependency is registered. Without this, fixing a malformed file
        // inside the directory would never trigger a re-parse.
        if (source.kind === "dir") failedDirRoot = resolved;
      } catch {
        /* rawPath unresolvable — no watcher dependency registered */
      }
    }
    const displayPath = failedPaths[0] ?? (source.kind !== "inline" ? source.rawPath : undefined);
    return {
      rows: [],
      dataPaths: failedPaths,
      dirRoot: failedDirRoot,
      error: displayPath ? `Failed to read ${displayPath}: ${message}` : `Failed to read data: ${message}`,
    };
  }
}

function readDirRows(
  source: Extract<SourceRef, { kind: "dir" }>,
  kind: "each" | "pick",
  options: { filePath: string; workspaceRoot: string },
): ReadRowsResult {
  const dirPath = resolveLoaderPath(source.rawPath, options);
  const files = collectFiles(dirPath, source.ext, source.recursive);
  // Include the directory root so the watcher has an entry even for empty
  // dirs. `dirRoot` is surfaced separately so testController can use the
  // correct matching strategy (insideDir) without relying on path.extname.
  const dataPaths = [dirPath, ...files];

  if (source.mode === "merge") {
    const merged: Record<string, unknown> = {};
    for (const file of files) {
      const value = loadSingleFile(file);
      if (isPlainObject(value)) Object.assign(merged, value);
    }
    return { rows: rowsFromValue(merged, kind), dataPaths, dirRoot: dirPath };
  }

  if (source.mode === "concat") {
    const rows: unknown[] = [];
    for (const file of files) {
      const value = loadFileAuto(file, source.pick);
      if (Array.isArray(value)) rows.push(...value);
    }
    return { rows: rowsFromValue(rows, kind), dataPaths, dirRoot: dirPath };
  }

  const rows = files.map((file) => {
    const content = loadSingleFile(file);
    const name = fileNameWithoutExt(file);
    const rel = path.relative(dirPath, file).replace(/\\/g, "/");
    return {
      _name: name,
      _path: rel,
      ...(isPlainObject(content) ? content : { data: content }),
    };
  });
  return { rows: rowsFromValue(rows, kind), dataPaths, dirRoot: dirPath };
}

function resolveLoaderPath(
  rawPath: string,
  options: { filePath: string; workspaceRoot: string },
): string {
  return resolveDataPath(rawPath, {
    sourceFilePath: options.filePath,
    workspaceRoot: options.workspaceRoot,
  }).resolvedPath;
}

function collectFiles(
  dirPath: string,
  extensions: string[] | undefined,
  recursive: boolean | undefined,
): string[] {
  const wanted = (extensions && extensions.length > 0
    ? extensions
    : [".json", ".yaml", ".yml"]
  ).map((ext) => ext.toLowerCase());
  const out: string[] = [];

  const walkDir = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walkDir(fullPath);
        continue;
      }

      if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (wanted.some((ext) => lower.endsWith(ext))) {
          out.push(fullPath);
        }
      }
    }
  };

  walkDir(dirPath);
  return out.sort();
}

function loadFileAuto(filePath: string, pick?: string): unknown {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".csv")) {
    return parseCsv(fs.readFileSync(filePath, "utf-8"));
  }
  if (lower.endsWith(".jsonl")) {
    return fs
      .readFileSync(filePath, "utf-8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
  }
  const value = loadSingleFile(filePath);
  return pickByPath(value, pick);
}

function loadSingleFile(filePath: string): unknown {
  const content = fs.readFileSync(filePath, "utf-8");
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) {
    return parseYaml(content);
  }
  if (lower.endsWith(".csv")) {
    return parseCsv(content)[0] ?? {};
  }
  if (lower.endsWith(".jsonl")) {
    const first = content.split("\n").find((line) => line.trim() !== "");
    return first ? JSON.parse(first) : {};
  }
  return JSON.parse(content);
}

function rowsFromValue(value: unknown, kind: "each" | "pick"): RowData[] {
  if (kind === "pick") {
    if (!isPlainObject(value)) return [];
    return Object.entries(value).map(([key, row], index) => ({
      index,
      pickKey: key,
      data: rowRecord(row, key),
    }));
  }

  if (Array.isArray(value)) {
    return value.map((row, index) => ({
      index,
      data: rowRecord(row),
    }));
  }

  if (isPlainObject(value)) {
    return Object.entries(value).map(([key, row], index) => ({
      index,
      pickKey: key,
      data: rowRecord(row, key),
    }));
  }

  return [];
}

function rowRecord(value: unknown, pickKey?: string): Record<string, unknown> {
  const base: Record<string, unknown> = isPlainObject(value)
    ? { ...value }
    : { value };
  if (pickKey !== undefined) base._pick = pickKey;
  return base;
}

function parseCsv(
  content: string,
  options: { separator?: string; headers?: boolean } = {},
): Record<string, string>[] {
  const separator = options.separator ?? ",";
  const hasHeaders = options.headers !== false;
  const lines = content.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return [];

  const parseLine = (line: string): string[] => {
    const fields: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (inQuotes) {
        if (char === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          current += char;
        }
      } else if (char === '"') {
        inQuotes = true;
      } else if (char === separator) {
        fields.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }

    fields.push(current.trim());
    return fields;
  };

  if (hasHeaders) {
    const headers = parseLine(lines[0]);
    return lines.slice(1).map((line) => {
      const values = parseLine(line);
      const record: Record<string, string> = {};
      for (let i = 0; i < headers.length; i++) {
        record[headers[i]] = values[i] ?? "";
      }
      return record;
    });
  }

  return lines.map((line) => {
    const values = parseLine(line);
    const record: Record<string, string> = {};
    for (let i = 0; i < values.length; i++) record[String(i)] = values[i];
    return record;
  });
}

function pickByPath(value: unknown, pick: string | undefined): unknown {
  if (!pick) return value;
  let current = value;
  for (const segment of pick.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function interpolateTemplate(
  template: string,
  data: Record<string, unknown>,
  index: number,
): string {
  let result = template.replace(/\$index/g, String(index));
  for (const [key, value] of Object.entries(data)) {
    result = result.replaceAll(`$${key}`, String(value));
  }
  return result;
}

function stripDataPrefix(id: string): string {
  if (id.startsWith("each:")) return id.slice("each:".length);
  if (id.startsWith("pick:")) return id.slice("pick:".length);
  return id;
}

function stripDataSuffix(name: string): string {
  return name
    .replace(/\s+\(data-driven\)$/, "")
    .replace(/\s+\(pick\)$/, "");
}

function hasUnresolvedTemplate(value: string): boolean {
  return /\$[A-Za-z_]\w*/.test(value);
}

function fileNameWithoutExt(filePath: string): string {
  const filename = path.basename(filePath);
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? filename : filename.slice(0, dot);
}

/**
 * Try to read a static value out of an expression. Returns `UNREADABLE`
 * for anything that can't be reduced to a primitive / array / object —
 * caller should fall through to "no rows" rather than guess.
 *
 * The previous TS-API version handled `+/-` numeric prefixes. We keep
 * that here so authors can write `[-1, 0, 1]` inline.
 */
function literalValue(node: AnyNode): unknown | typeof UNREADABLE {
  const expr = unwrapAll(node);
  if (!expr) return UNREADABLE;

  if (expr.type === "Literal") {
    const value = (expr as AnyNode).value;
    // acorn `Literal` covers strings, numbers, booleans, null, regex.
    // Regex is the only unhelpful kind; we treat it as unreadable so a
    // regex sneaking into inline data doesn't get materialised as `{}`.
    if (value instanceof RegExp) return UNREADABLE;
    return value;
  }

  if (expr.type === "TemplateLiteral") {
    const expressions = (expr as AnyNode).expressions as AnyNode[] | undefined;
    const quasis = (expr as AnyNode).quasis as AnyNode[] | undefined;
    if (expressions && expressions.length === 0 && quasis && quasis.length === 1) {
      return (quasis[0]!.value as { cooked?: string }).cooked ?? "";
    }
    return UNREADABLE;
  }

  if (expr.type === "Identifier") {
    if ((expr as AnyNode).name === "undefined") return undefined;
    return UNREADABLE;
  }

  if (expr.type === "UnaryExpression") {
    const operator = (expr as AnyNode).operator as string;
    if (operator !== "+" && operator !== "-") return UNREADABLE;
    const argument = (expr as AnyNode).argument as AnyNode;
    if (argument.type !== "Literal") return UNREADABLE;
    const raw = (argument as AnyNode).value;
    if (typeof raw !== "number") return UNREADABLE;
    return operator === "-" ? -raw : raw;
  }

  if (expr.type === "ArrayExpression") {
    const elements = (expr as AnyNode).elements as Array<AnyNode | null> | undefined;
    if (!elements) return [];
    const values: unknown[] = [];
    for (const element of elements) {
      if (!element) {
        values.push(undefined);
        continue;
      }
      if (element.type === "SpreadElement") return UNREADABLE;
      const value = literalValue(element);
      if (value === UNREADABLE) return UNREADABLE;
      values.push(value);
    }
    return values;
  }

  if (expr.type === "ObjectExpression") {
    const properties = (expr as AnyNode).properties as AnyNode[] | undefined;
    const out: Record<string, unknown> = {};
    if (!properties) return out;
    for (const property of properties) {
      if (property.type !== "Property") return UNREADABLE;
      const key = propertyNameText(property);
      if (!key) return UNREADABLE;
      const valueNode = (property as AnyNode).value as AnyNode | undefined;
      if (!valueNode) return UNREADABLE;
      const value = literalValue(valueNode);
      if (value === UNREADABLE) return UNREADABLE;
      out[key] = value;
    }
    return out;
  }

  return UNREADABLE;
}

/**
 * Strip type wrappers AND `await`. Cookbook commonly writes
 * `test.each(await fromCsv(...))` so the data argument we receive is an
 * `AwaitExpression` — for the purposes of "what's the runtime
 * expression?" await is the same as a wrapper.
 */
function unwrapAll(expr: AnyNode | undefined): AnyNode | undefined {
  let current: AnyNode | undefined = expr;
  while (current) {
    const next = astUnwrap(current);
    if (!next) return undefined;
    if (next.type === "AwaitExpression") {
      current = (next as AnyNode).argument as AnyNode;
      continue;
    }
    if (next === current) return current;
    current = next;
  }
  return current;
}

/**
 * Slimmer unwrap for callee position — the AST helper handles the type
 * cases; await on the callee is exotic enough we don't bother.
 */
function unwrapCallee(callee: AnyNode): AnyNode {
  return astUnwrap(callee) ?? callee;
}

function booleanFromExpression(expression: AnyNode): boolean | undefined {
  const expr = unwrapAll(expression);
  if (!expr) return undefined;
  if (expr.type === "Literal") {
    const value = (expr as AnyNode).value;
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function stringArrayFromExpression(expression: AnyNode): string[] {
  const expr = unwrapAll(expression);
  if (!expr) return [];
  const scalar = astStringFromExpression(expr);
  if (scalar) return [scalar];
  if (expr.type !== "ArrayExpression") return [];

  const elements = (expr as AnyNode).elements as Array<AnyNode | null> | undefined;
  if (!elements) return [];
  const values: string[] = [];
  for (const element of elements) {
    if (!element) return [];
    if (element.type === "SpreadElement") return [];
    const value = astStringFromExpression(element);
    if (!value) return [];
    values.push(value);
  }
  return values;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
