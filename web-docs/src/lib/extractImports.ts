// File-level import extraction (design.md D2; spec "Cross-component edges
// are derived, classified, and checked against a reviewed snapshot").
//
// Builds a `ts.Program` from an explicitly supplied file list — never from
// a workspace tsconfig's own `include`/`exclude` (companion's tsconfig
// excludes its own test files, which this extractor must still see) — then
// resolves every static import/export-from declaration, literal dynamic
// `import()` call, and type-position `import('...')` reference (both
// `typeof import('x')` and a direct `import('x').Member` type — collectively
// `ts.ImportTypeNode`, always type-only; there is no value-level form of
// this syntax) through that file's OWNING workspace's real
// `compilerOptions`, covering all four real resolution regimes: server
// (Bundler), web (bundler + `paths` aliases + `.ts` extensions), companion
// (NodeNext `.js`-specifiers for `.ts` files), e2e (Bundler).
//
// Resolution mechanics: `ts.createProgram` is used to parse each mapped
// file into a `ts.SourceFile` (correct JSX/scriptKind handling per
// extension) — the literal "ts.Program built from the mapped-file list"
// requirement — but each specifier is resolved via the standalone, publicly
// documented `ts.resolveModuleName(specifier, containingFile, options,
// host)`, not `Program#getResolvedModuleWithFailedLookupLocationsFromCache`
// (that method is declared in older `ts.Program` typings but throws "not a
// function" at runtime against the installed 5.9.3 — verified empirically
// before writing this module). `resolveModuleName` reuses the exact same
// resolution algorithm and needs no whole-program cache, so the two are
// equivalent for this extractor's purposes.
//
// Deliberately narrow: `fixtures/api-responses/**` and `web-docs/`'s own
// mapped files fall outside all four regimes and are never used as
// extraction roots — design.md D2 names exactly four regimes. Verified
// empirically (see task-3.1-3.2 report) that no `fixtures/api-responses/*.ts`
// file has an outgoing import outside its own component (`_mutable.ts` is
// the only cross-file import, intra-component), so this scope decision
// drops no real edge as of this writing.

import path from 'node:path';
import ts from 'typescript';

export interface WorkspaceRegime {
  /** Short regime name, used only for diagnostics. */
  name: string;
  /** Repo-relative workspace directory, e.g. 'server'. No trailing slash. */
  dir: string;
  /** Repo-relative path to the workspace's tsconfig.json. */
  tsconfigPath: string;
}

/**
 * The four real resolution regimes (design.md D2). `compilerOptions` are
 * read from each workspace's real tsconfig at extraction time — never its
 * `include`/`exclude`, which only shapes each workspace's OWN build/
 * typecheck file set (and companion's excludes its own tests outright).
 */
export const WORKSPACE_REGIMES: readonly WorkspaceRegime[] = [
  { name: 'server', dir: 'server', tsconfigPath: 'server/tsconfig.json' },
  { name: 'web', dir: 'web', tsconfigPath: 'web/tsconfig.json' },
  { name: 'companion', dir: 'companion', tsconfigPath: 'companion/tsconfig.json' },
  { name: 'e2e', dir: 'e2e', tsconfigPath: 'e2e/tsconfig.json' },
];

export type FileImportKind = 'static' | 'dynamic-literal';

/** A single file-level import/export-from/dynamic-import() edge, resolved to an in-repo target. */
export interface FileImport {
  fromFile: string;
  toFile: string;
  kind: FileImportKind;
  isTypeOnly: boolean;
  /** 1-based line of the specifier (or call), for provenance in failure messages. */
  line: number;
}

/** A non-literal dynamic `import()` call — its target cannot be statically determined. */
export interface DynamicImportWarning {
  file: string;
  line: number;
  column: number;
}

/** An import resolving to an in-repo file that is neither mapped nor excluded. */
export interface UnmappedImportError {
  fromFile: string;
  toFile: string;
}

export interface ExtractionResult {
  imports: FileImport[];
  dynamicWarnings: DynamicImportWarning[];
  unmappedImportErrors: UnmappedImportError[];
}

export interface ExtractFileImportsParams {
  /** Repo-relative paths of every file to extract from (already filtered to mapped components). */
  files: string[];
  /** Absolute path to the repo root (or fixture root in tests). */
  repoRoot: string;
  /** True when a repo-relative path is mapped to a component or on the model's exclusion list. */
  isKnown: (repoRelativeFile: string) => boolean;
  /** Override point for fixture-tree tests. Defaults to WORKSPACE_REGIMES. */
  regimes?: readonly WorkspaceRegime[];
}

function loadCompilerOptions(regime: WorkspaceRegime, repoRoot: string): ts.CompilerOptions {
  const configPath = path.join(repoRoot, regime.tsconfigPath);
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      `extractImports: failed to read ${regime.tsconfigPath}: ` +
        ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'),
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.join(repoRoot, regime.dir),
  );
  return parsed.options;
}

function toRepoRelative(absPath: string, repoRoot: string): string {
  return path.relative(repoRoot, absPath).split(path.sep).join('/');
}

function regimeForFile(
  repoRelFile: string,
  regimes: readonly WorkspaceRegime[],
): WorkspaceRegime | undefined {
  return regimes.find((r) => repoRelFile === r.dir || repoRelFile.startsWith(`${r.dir}/`));
}

interface WalkResult {
  imports: FileImport[];
  warnings: DynamicImportWarning[];
}

function walkSourceFile(
  sourceFile: ts.SourceFile,
  fromFileRel: string,
  resolveSpecifier: (specifier: string) => ts.ResolvedModuleFull | undefined,
  repoRoot: string,
): WalkResult {
  const imports: FileImport[] = [];
  const warnings: DynamicImportWarning[] = [];

  function recordSpecifier(
    specifierNode: ts.StringLiteralLike,
    kind: FileImportKind,
    isTypeOnly: boolean,
  ) {
    const resolved = resolveSpecifier(specifierNode.text);
    // Unresolved (CSS/images/bundler-only assets) or a node_modules package —
    // both ignored per spec ("unresolvable non-TypeScript specifiers ...
    // ignored"); external libraries are simply not in-repo edges.
    if (!resolved || resolved.isExternalLibraryImport) return;
    const resolvedAbs = path.resolve(resolved.resolvedFileName);
    if (resolvedAbs !== repoRoot && !resolvedAbs.startsWith(repoRoot + path.sep)) {
      return; // defensive: resolved outside the repo root entirely
    }
    if (resolvedAbs.includes(`${path.sep}node_modules${path.sep}`)) return;

    const toFile = toRepoRelative(resolvedAbs, repoRoot);
    const { line } = sourceFile.getLineAndCharacterOfPosition(specifierNode.getStart(sourceFile));
    imports.push({ fromFile: fromFileRel, toFile, kind, isTypeOnly, line: line + 1 });
  }

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      recordSpecifier(node.moduleSpecifier, 'static', node.importClause?.isTypeOnly === true);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      recordSpecifier(node.moduleSpecifier, 'static', node.isTypeOnly === true);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) {
        recordSpecifier(arg, 'dynamic-literal', false);
      } else {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        warnings.push({ file: fromFileRel, line: line + 1, column: character + 1 });
      }
    } else if (ts.isImportTypeNode(node)) {
      // Type-position `import('...')` references — both `typeof import('x')`
      // (isTypeOf: true) and a direct `import('x').Member` type reference
      // (isTypeOf: false). Always a type-only structural dependency: there
      // is no value-level form of this syntax.
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal)) {
        recordSpecifier(argument.literal, 'static', true);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { imports, warnings };
}

/**
 * Extracts file-level import edges from `params.files`, resolved under
 * each file's owning workspace regime. Files outside every declared regime
 * are silently skipped (not an error — see module header on scope).
 */
export function extractFileImports(params: ExtractFileImportsParams): ExtractionResult {
  const { files, repoRoot, isKnown } = params;
  const regimes = params.regimes ?? WORKSPACE_REGIMES;

  const imports: FileImport[] = [];
  const dynamicWarnings: DynamicImportWarning[] = [];
  const unmappedImportErrors: UnmappedImportError[] = [];

  const byRegime = new Map<WorkspaceRegime, string[]>();
  for (const file of files) {
    const regime = regimeForFile(file, regimes);
    if (!regime) continue;
    const list = byRegime.get(regime) ?? [];
    list.push(file);
    byRegime.set(regime, list);
  }

  for (const [regime, regimeFiles] of byRegime) {
    if (regimeFiles.length === 0) continue;
    const options = loadCompilerOptions(regime, repoRoot);
    const host = ts.createCompilerHost(options);
    const rootNames = regimeFiles.map((file) => path.join(repoRoot, file));
    const program = ts.createProgram({ rootNames, options, host });

    for (const file of regimeFiles) {
      const abs = path.join(repoRoot, file);
      const sourceFile = program.getSourceFile(abs);
      if (!sourceFile) continue; // file is a rootName; should always be present

      const resolveSpecifier = (specifier: string) =>
        ts.resolveModuleName(specifier, abs, options, host).resolvedModule;

      const { imports: fileImports, warnings } = walkSourceFile(
        sourceFile,
        file,
        resolveSpecifier,
        repoRoot,
      );
      for (const warning of warnings) dynamicWarnings.push(warning);
      for (const imp of fileImports) {
        if (isKnown(imp.toFile)) {
          imports.push(imp);
        } else {
          unmappedImportErrors.push({ fromFile: imp.fromFile, toFile: imp.toFile });
        }
      }
    }
  }

  imports.sort(
    (a, b) =>
      a.fromFile.localeCompare(b.fromFile) || a.toFile.localeCompare(b.toFile) || a.line - b.line,
  );
  dynamicWarnings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
  );
  unmappedImportErrors.sort(
    (a, b) => a.fromFile.localeCompare(b.fromFile) || a.toFile.localeCompare(b.toFile),
  );

  return { imports, dynamicWarnings, unmappedImportErrors };
}
