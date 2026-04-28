/**
 * Contract / flow / bootstrap extraction from `.contract.ts` / `.flow.ts` /
 * `.bootstrap.ts` files. Replaces the previous regex + char-walker with a
 * real AST traversal via the shared `ast.ts` helper (acorn + acorn-typescript).
 *
 * Public API and behaviour are unchanged — the rewrite is bundle-only:
 * the old version pulled in the full `typescript` module (~3 MB). This
 * version uses acorn (~600 KB total).
 */

import {
  forEachExportedConst,
  findPropertyCall,
  hasLeadingMarker,
  lineOf,
  objectFromExpression,
  objectProperty,
  parseSource,
  propertyNameText,
  stringFromExpression,
  stringProperty,
  unwrapExpression,
  type AnyNode,
  type SourceFile,
} from "./ast";

export interface AstContractCase {
  key: string;
  line: number; // 1-based
  deferred?: string;
  deprecated?: string;
  requires?: string;
  defaultRun?: string;
}

export interface AstContract {
  exportName: string;
  line: number; // 1-based export name line
  contractId: string;
  endpoint?: string;
  cases: AstContractCase[];
}

export interface AstFlow {
  exportName: string;
  line: number; // 1-based export name line
  flowId: string;
  skip?: string;
}

export interface BootstrapMarker {
  /** The exporting variable name in the .bootstrap.ts file (e.g. `meAuthorizedOverlay`). */
  exportName: string;
  /** 1-based line number where `export const X = contract.bootstrap(...)` starts. */
  exportLine: number;
  /** Local identifier referenced via `IDENT.case("KEY")` (e.g. `getMe`). */
  targetIdent: string;
  /** The case key (e.g. `authorized`) referenced via `.case("KEY")`. */
  caseKey: string;
}

export function extractMarkedContracts(content: string, filePath = "input.ts"): AstContract[] {
  return extractContracts(content, filePath, true);
}

export function extractContracts(
  content: string,
  filePath = "input.ts",
  requireMarker = false,
): AstContract[] {
  const source = safeParse(content, filePath);
  if (!source) return [];
  const contracts: AstContract[] = [];

  forEachExportedConst(source, (statement, declaration) => {
    if (requireMarker && !hasLeadingMarker(source, statement, "contract")) return;
    const name = nameOf(declaration);
    if (!name) return;
    const initializer = (declaration as AnyNode).init as AnyNode | undefined;
    if (!initializer) return;

    const spec = readContractCall(initializer);
    if (!spec) return;

    contracts.push({
      exportName: name.text,
      line: lineOf(name.node),
      contractId: spec.contractId,
      endpoint: stringProperty(spec.spec, "endpoint"),
      cases: readCases(spec.spec),
    });
  });

  return contracts;
}

export function extractMarkedFlows(content: string, filePath = "input.ts"): AstFlow[] {
  const source = safeParse(content, filePath);
  if (!source) return [];
  const flows: AstFlow[] = [];

  forEachExportedConst(source, (statement, declaration) => {
    if (!hasLeadingMarker(source, statement, "flow")) return;
    const name = nameOf(declaration);
    if (!name) return;
    const initializer = (declaration as AnyNode).init as AnyNode | undefined;
    if (!initializer) return;

    const flowCall = findPropertyCall(initializer, "flow");
    const flowArgs = flowCall ? ((flowCall as AnyNode).arguments as AnyNode[]) : undefined;
    const flowId = flowArgs ? stringFromExpression(flowArgs[0]) : undefined;
    if (!flowId) return;

    const metaCall = findPropertyCall(initializer, "meta");
    const metaArgs = metaCall ? ((metaCall as AnyNode).arguments as AnyNode[]) : undefined;
    const meta = metaArgs ? objectFromExpression(metaArgs[0]) : undefined;

    flows.push({
      exportName: name.text,
      line: lineOf(name.node),
      flowId,
      skip: meta ? stringProperty(meta, "skip") : undefined,
    });
  });

  return flows;
}

export function extractBootstrapMarkers(
  content: string,
  filePath = "input.ts",
): BootstrapMarker[] {
  const source = safeParse(content, filePath);
  if (!source) return [];
  const markers: BootstrapMarker[] = [];

  forEachExportedConst(source, (_statement, declaration) => {
    const name = nameOf(declaration);
    if (!name) return;
    const initializer = (declaration as AnyNode).init as AnyNode | undefined;
    if (!initializer) return;

    const bootstrapCall = findPropertyCall(initializer, "bootstrap");
    if (!bootstrapCall) return;

    const args = (bootstrapCall as AnyNode).arguments as AnyNode[] | undefined;
    if (!args || args.length === 0) return;

    const firstArg = unwrapExpression(args[0]);
    if (!firstArg || firstArg.type !== "CallExpression") return;
    const callee = firstArg.callee as AnyNode;
    if (callee.type !== "MemberExpression") return;
    const calleeProperty = callee.property as AnyNode;
    if (calleeProperty.type !== "Identifier" || (calleeProperty as AnyNode).name !== "case") return;
    const calleeObject = callee.object as AnyNode;
    if (calleeObject.type !== "Identifier") return;

    const caseArgs = (firstArg as AnyNode).arguments as AnyNode[] | undefined;
    if (!caseArgs || caseArgs.length === 0) return;
    const caseKey = stringFromExpression(caseArgs[0]);
    if (!caseKey) return;

    markers.push({
      exportName: name.text,
      exportLine: lineOf(name.node),
      targetIdent: calleeObject.name as string,
      caseKey,
    });
  });

  return markers;
}

export function findImportPath(
  content: string,
  localIdent: string,
  filePath = "input.ts",
): { path: string; originalName: string } | undefined {
  const source = safeParse(content, filePath);
  if (!source) return undefined;

  for (const statement of source.program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    const specifiers = (statement as AnyNode).specifiers as AnyNode[] | undefined;
    const sourceNode = (statement as AnyNode).source as AnyNode | undefined;
    if (!specifiers || !sourceNode) continue;
    const path = stringFromExpression(sourceNode);
    if (!path) continue;

    for (const specifier of specifiers) {
      // Only `ImportSpecifier` uses named import — skip `ImportDefaultSpecifier`
      // and `ImportNamespaceSpecifier`. Matches old TS-API behavior.
      if (specifier.type !== "ImportSpecifier") continue;
      const local = specifier.local as AnyNode;
      const imported = specifier.imported as AnyNode;
      if (local.type !== "Identifier" || (local as AnyNode).name !== localIdent) continue;
      // `imported` can be Identifier (named import) or Literal (string-named
      // re-export — `import { "x" as y } from "..."` is rare but legal).
      const originalName =
        imported.type === "Identifier"
          ? (imported as AnyNode).name as string
          : imported.type === "Literal" && typeof (imported as AnyNode).value === "string"
            ? ((imported as AnyNode).value as string)
            : (local as AnyNode).name as string;
      return { path, originalName };
    }
  }

  return undefined;
}

export function findContractIdInTarget(
  content: string,
  exportName: string,
  filePath = "input.ts",
): string | undefined {
  const source = safeParse(content, filePath);
  if (!source) return undefined;

  let contractId: string | undefined;
  forEachExportedConst(source, (_statement, declaration) => {
    if (contractId) return;
    const name = nameOf(declaration);
    if (!name || name.text !== exportName) return;
    const initializer = (declaration as AnyNode).init as AnyNode | undefined;
    if (!initializer) return;
    contractId = readContractCall(initializer)?.contractId;
  });

  return contractId;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Acorn throws on syntax errors. The previous TS-API version was tolerant
 * (parsed permissively, returned what it could). Match that — invalid
 * input means the file isn't ready and we return no extractions rather
 * than blowing up the calling CodeLens / Test Explorer pass.
 */
function safeParse(content: string, filePath: string): SourceFile | undefined {
  try {
    return parseSource(content, filePath);
  } catch {
    return undefined;
  }
}

interface IdentifierBinding {
  text: string;
  node: AnyNode;
}

/**
 * A `VariableDeclarator` may have an identifier or a destructuring pattern
 * in `id`. We only handle plain identifiers — destructuring exports
 * aren't a contract pattern we need to detect. Returns `undefined` for
 * anything else so the caller skips it.
 */
function nameOf(declaration: AnyNode): IdentifierBinding | undefined {
  const id = declaration.id as AnyNode | undefined;
  if (!id || id.type !== "Identifier") return undefined;
  return { text: (id as AnyNode).name as string, node: id };
}

/**
 * Recognise the call shape of `<contractFactory>(<id>, <spec>)` where the
 * factory is anything (`contract.http("...", spec)`, `myApi("...", spec)`,
 * etc.) and `<spec>` carries a `cases:` property — that last gate is the
 * cheapest "this looks like a Glubean contract" check available without
 * type info.
 */
function readContractCall(
  expression: AnyNode,
): { contractId: string; spec: AnyNode } | undefined {
  const unwrapped = unwrapExpression(expression);
  if (!unwrapped || unwrapped.type !== "CallExpression") return undefined;

  const args = (unwrapped as AnyNode).arguments as AnyNode[] | undefined;
  if (!args || args.length < 2) return undefined;

  const contractId = stringFromExpression(args[0]);
  const spec = objectFromExpression(args[1]);
  if (!contractId || !spec) return undefined;
  if (!objectProperty(spec, "cases")) return undefined;

  return { contractId, spec };
}

function readCases(spec: AnyNode): AstContractCase[] {
  const casesProp = objectProperty(spec, "cases");
  if (!casesProp) return [];
  const initializer = (casesProp as AnyNode).value as AnyNode | undefined;
  if (!initializer) return [];
  const casesObject = objectFromExpression(initializer);
  if (!casesObject) return [];

  const cases: AstContractCase[] = [];
  const properties = casesObject.properties as AnyNode[] | undefined;
  if (!properties) return cases;

  for (const property of properties) {
    // Spread (`...sharedCases`) is silently skipped — same behavior as
    // the previous detector. The cookbook-shared-cases flow won't show
    // shared cases under the local contract's gutter ▶ button.
    if (property.type === "SpreadElement") continue;
    if (property.type !== "Property") continue;
    const key = propertyNameText(property);
    if (!key) continue;

    const valueNode = (property as AnyNode).value as AnyNode | undefined;
    const inline = valueNode ? objectFromExpression(valueNode) : undefined;

    const caseMeta: AstContractCase = {
      key,
      line: lineOf((property as AnyNode).key as AnyNode),
    };

    if (inline) {
      const deferred = stringProperty(inline, "deferred");
      const deprecated = stringProperty(inline, "deprecated");
      const requires = stringProperty(inline, "requires");
      const defaultRun = stringProperty(inline, "defaultRun");
      if (deferred) caseMeta.deferred = deferred;
      if (deprecated) caseMeta.deprecated = deprecated;
      if (requires) caseMeta.requires = requires;
      if (defaultRun) caseMeta.defaultRun = defaultRun;
    }

    cases.push(caseMeta);
  }

  return cases;
}
