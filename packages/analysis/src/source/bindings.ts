import ts from 'typescript';
import { accessPath, literalText, rootIdentifier, simpleName, walk } from './ast.js';
import type { ModuleResolver, ResolvedModule } from './module-resolver.js';

/**
 * What every name in a module refers to.
 *
 * This is the piece that lets the analyzers resolve edges by evidence instead
 * of by resemblance. When a route handler mentions `controller.createUser`, the
 * binding table says where `controller` came from — `new UserController()`,
 * itself imported from `./controllers/user.controller.js` — so the edge can
 * point at that exact node, or at nothing at all. No repository-wide search for
 * something plausibly called `UserController` ever happens.
 */

export type Binding =
  /** Imported from another file in this repository. */
  | { kind: 'import'; from: string; exportedName: string; typeOnly: boolean }
  /** Imported from an external package. */
  | { kind: 'package'; packageName: string; exportedName: string; typeOnly: boolean }
  /** Imported from Node's standard library. */
  | { kind: 'builtin'; moduleName: string; exportedName: string; typeOnly: boolean }
  /** Declared in this file. */
  | { kind: 'local'; declaredName: string; node: ts.Node }
  /**
   * A local whose value comes from constructing something: the binding both
   * names a local and records the class it instantiates, which is how
   * `const controller = new UserController()` becomes a resolvable handler.
   */
  | { kind: 'instance'; className: string; from: Binding | null; node: ts.Node }
  /**
   * A local whose value comes from calling something imported:
   * `const router = Router()`. `callee` is the binding of the thing called.
   */
  | { kind: 'call'; calleeName: string; callee: Binding | null; node: ts.Node };

export interface ExportedBinding {
  exportedName: string;
  /** Name as declared locally, which differs under `export { a as b }`. */
  localName: string;
}

export class BindingTable {
  private readonly bindings = new Map<string, Binding>();
  private readonly exported: ExportedBinding[] = [];
  private readonly reexports: Array<{ from: string; exportedName: string; localName: string }> = [];
  private readonly constants = new Map<string, string>();
  private readonly importedPackages = new Set<string>();
  private readonly importedFiles = new Set<string>();
  private readonly sideEffectImports: Array<{ module: ResolvedModule; line: number }> = [];

  constructor(
    readonly relativePath: string,
    private readonly sourceFile: ts.SourceFile,
    private readonly resolver: ModuleResolver,
  ) {
    this.collectImports();
    this.collectDeclarations();
    this.collectExports();
  }

  get(name: string): Binding | undefined {
    return this.bindings.get(name);
  }

  /**
   * The value of a module-level string constant. Route paths and event names
   * are routinely declared once and referenced by name, and a name is no less
   * literal than the string it is declared as.
   */
  constant(name: string): string | undefined {
    return this.constants.get(name);
  }

  /** The binding of the leading identifier of an expression. */
  forExpression(expression: ts.Expression): Binding | undefined {
    const root = rootIdentifier(expression);
    return root === null ? undefined : this.bindings.get(root);
  }

  /** Every package this module imports, in source order. */
  packages(): readonly string[] {
    return [...this.importedPackages];
  }

  /** Every repository file this module imports. */
  files(): readonly string[] {
    return [...this.importedFiles];
  }

  exports(): readonly ExportedBinding[] {
    return this.exported;
  }

  /** `export { x } from './y'` — an export whose declaration is elsewhere. */
  reexported(): ReadonlyArray<{ from: string; exportedName: string; localName: string }> {
    return this.reexports;
  }

  /** True when this module imports anything from the given package. */
  importsPackage(packageName: string): boolean {
    return this.importedPackages.has(packageName);
  }

  /** True when it imports from the package or any package under a scope. */
  importsFrom(predicate: (packageName: string) => boolean): boolean {
    for (const name of this.importedPackages) {
      if (predicate(name)) return true;
    }
    return false;
  }

  /**
   * Resolves a binding to the package it ultimately came from, following one
   * level of local aliasing: `const R = Router` then `R()`.
   */
  packageOfBinding(binding: Binding | undefined): string | null {
    if (!binding) return null;
    if (binding.kind === 'package') return binding.packageName;
    if (binding.kind === 'call') return this.packageOfBinding(binding.callee ?? undefined);
    if (binding.kind === 'instance') return this.packageOfBinding(binding.from ?? undefined);
    return null;
  }

  private collectImports(): void {
    for (const statement of this.sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) {
        this.collectImportDeclaration(statement);
        continue;
      }
      if (ts.isImportEqualsDeclaration(statement)) {
        // `import x = require('y')`
        const reference = statement.moduleReference;
        if (!ts.isExternalModuleReference(reference)) continue;
        const specifier = literalText(reference.expression);
        if (specifier === null) continue;
        this.record(statement.name.text, specifier, 'default', false);
      }
    }

    // `const { Router } = require('express')` and `const x = require('y')`.
    for (const statement of this.sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;

      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer;
        if (!initializer || !ts.isCallExpression(initializer)) continue;
        if (!ts.isIdentifier(initializer.expression)) continue;
        if (initializer.expression.text !== 'require') continue;

        const specifier = literalText(initializer.arguments[0]);
        if (specifier === null) continue;

        if (ts.isIdentifier(declaration.name)) {
          this.record(declaration.name.text, specifier, 'default', false);
          continue;
        }
        if (ts.isObjectBindingPattern(declaration.name)) {
          for (const element of declaration.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const imported =
              element.propertyName && ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : element.name.text;
            this.record(element.name.text, specifier, imported, false);
          }
        }
      }
    }
  }

  private collectImportDeclaration(statement: ts.ImportDeclaration): void {
    const specifier = literalText(statement.moduleSpecifier);
    if (specifier === null) return;

    const resolved = this.resolver.resolve(this.relativePath, specifier);
    this.noteModule(resolved);

    const clause = statement.importClause;
    if (!clause) {
      // `import './setup.js'` — a side-effect import. It is still a dependency.
      this.sideEffectImports.push({
        module: resolved,
        line: this.sourceFile.getLineAndCharacterOfPosition(statement.getStart(this.sourceFile))
          .line + 1,
      });
      return;
    }

    const typeOnly = clause.isTypeOnly;

    if (clause.name) this.record(clause.name.text, specifier, 'default', typeOnly);

    const named = clause.namedBindings;
    if (!named) return;

    if (ts.isNamespaceImport(named)) {
      this.record(named.name.text, specifier, '*', typeOnly);
      return;
    }

    for (const element of named.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      this.record(element.name.text, specifier, imported, typeOnly || element.isTypeOnly);
    }
  }

  private record(localName: string, specifier: string, exportedName: string, typeOnly: boolean): void {
    const resolved = this.resolver.resolve(this.relativePath, specifier);
    this.noteModule(resolved);

    if (resolved.kind === 'file') {
      this.bindings.set(localName, {
        kind: 'import',
        from: resolved.relativePath,
        exportedName,
        typeOnly,
      });
      return;
    }
    if (resolved.kind === 'package') {
      this.bindings.set(localName, {
        kind: 'package',
        packageName: resolved.packageName,
        exportedName,
        typeOnly,
      });
      return;
    }
    if (resolved.kind === 'builtin') {
      this.bindings.set(localName, {
        kind: 'builtin',
        moduleName: resolved.moduleName,
        exportedName,
        typeOnly,
      });
    }
  }

  private noteModule(resolved: ResolvedModule): void {
    if (resolved.kind === 'package') this.importedPackages.add(resolved.packageName);
    if (resolved.kind === 'file') this.importedFiles.add(resolved.relativePath);
  }

  /** Side-effect imports, which carry no binding but are real dependencies. */
  sideEffects(): ReadonlyArray<{ module: ResolvedModule; line: number }> {
    return this.sideEffectImports;
  }

  /**
   * One flat table per module, with the first declaration of a name winning.
   *
   * There is no scope tree here on purpose. Tracking scopes properly means
   * building one, and the analyzers that need positional precision — which
   * definition a finding sits inside — get it from the graph's own ranges
   * instead. The cost is that a name declared in two different function bodies
   * resolves to the first; the benefit is that resolution stays a lookup, and
   * every analyzer is free to require stronger evidence before emitting an edge.
   */
  private collectDeclarations(): void {
    for (const statement of this.sourceFile.statements) {
      if (
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isFunctionDeclaration(statement)
      ) {
        const name = statement.name?.text;
        if (name) this.bindings.set(name, { kind: 'local', declaredName: name, node: statement });
        continue;
      }

      if (!ts.isVariableStatement(statement)) continue;

      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const name = declaration.name.text;
        const initializer = declaration.initializer;

        const literal = literalText(initializer);
        if (literal !== null) this.constants.set(name, literal);

        const binding = this.bindingForInitializer(name, declaration, initializer);
        this.bindings.set(name, binding);
      }
    }

    // Class fields initialised in place or assigned in a constructor:
    // `private readonly repository = new UserRepository()`. Recorded under
    // `this.<field>` so an access path resolves directly.
    walk(this.sourceFile, (node) => {
      if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
        const binding = this.bindingForInitializer(node.name.text, node, node.initializer);
        this.remember(`this.${node.name.text}`, binding);
        return;
      }

      // Locals inside a function body: `const router = Router()` in a factory.
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        !this.bindings.has(node.name.text)
      ) {
        const literal = literalText(node.initializer);
        if (literal !== null && !this.constants.has(node.name.text)) {
          this.constants.set(node.name.text, literal);
        }
        this.remember(
          node.name.text,
          this.bindingForInitializer(node.name.text, node, node.initializer),
        );
        return;
      }

      // A parameter's declared type is evidence about the value it carries,
      // whether it is a constructor's — `constructor(private readonly repo:
      // UserRepository)`, reached as `this.repo` — or a plain function's —
      // `createUserRouter(controller: UserController)`, reached by its own name.
      if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
        const typeName = node.type ? nameOfTypeNode(node.type) : null;
        if (typeName === null) return;

        const binding: Binding = {
          kind: 'instance',
          className: typeName,
          from: this.bindings.get(typeName) ?? null,
          node,
        };

        if (node.parent && ts.isConstructorDeclaration(node.parent)) {
          this.remember(`this.${node.name.text}`, binding);
        }
        // Keyed by the plain name too: inside the function body that is how the
        // parameter is referred to.
        this.remember(node.name.text, binding);
      }
    });
  }

  /** Records a binding unless the name already has one. */
  private remember(name: string, binding: Binding): void {
    if (!this.bindings.has(name)) this.bindings.set(name, binding);
  }

  private bindingForInitializer(
    name: string,
    node: ts.Node,
    initializer: ts.Expression | undefined,
  ): Binding {
    if (initializer && ts.isNewExpression(initializer)) {
      const className = simpleName(initializer.expression);
      if (className !== null) {
        return {
          kind: 'instance',
          className,
          from: this.bindings.get(className) ?? null,
          node,
        };
      }
    }

    if (initializer && ts.isCallExpression(initializer)) {
      const calleeRoot = rootIdentifier(initializer.expression);
      const calleeName = accessPath(initializer.expression) ?? calleeRoot ?? '';
      return {
        kind: 'call',
        calleeName,
        callee: calleeRoot === null ? null : this.bindings.get(calleeRoot) ?? null,
        node,
      };
    }

    // An annotated declaration without an initializer still names its type,
    // which is enough to resolve a member access against it.
    const declaredType =
      (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && node.type
        ? nameOfTypeNode(node.type)
        : null;

    if (declaredType !== null) {
      return {
        kind: 'instance',
        className: declaredType,
        from: this.bindings.get(declaredType) ?? null,
        node,
      };
    }

    return { kind: 'local', declaredName: name, node };
  }

  private collectExports(): void {
    for (const statement of this.sourceFile.statements) {
      if (ts.isExportDeclaration(statement)) {
        const from = statement.moduleSpecifier ? literalText(statement.moduleSpecifier) : null;
        const clause = statement.exportClause;

        if (clause && ts.isNamedExports(clause)) {
          for (const element of clause.elements) {
            const localName = element.propertyName?.text ?? element.name.text;
            if (from === null) {
              this.exported.push({ exportedName: element.name.text, localName });
              continue;
            }
            const resolved = this.resolver.resolve(this.relativePath, from);
            this.noteModule(resolved);
            if (resolved.kind === 'file') {
              this.reexports.push({
                from: resolved.relativePath,
                exportedName: element.name.text,
                localName,
              });
            }
          }
        }
        continue;
      }

      if (!hasExportModifier(statement)) continue;

      if (
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isFunctionDeclaration(statement)
      ) {
        const name = statement.name?.text;
        if (name) this.exported.push({ exportedName: name, localName: name });
        continue;
      }

      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            this.exported.push({
              exportedName: declaration.name.text,
              localName: declaration.name.text,
            });
          }
        }
      }
    }
  }
}

function hasExportModifier(statement: ts.Statement): boolean {
  if (!ts.canHaveModifiers(statement)) return false;
  return (ts.getModifiers(statement) ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

/** The bare name of a type annotation: `UserRepository` in `UserRepository`. */
function nameOfTypeNode(type: ts.TypeNode): string | null {
  if (ts.isTypeReferenceNode(type)) return simpleName(type.typeName);
  return null;
}
