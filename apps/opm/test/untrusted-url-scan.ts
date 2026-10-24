import ts from 'typescript';

/**
 * Finds every way a source file hands text to a URL parser, by the TypeScript
 * parser.
 *
 * Node's `new URL` takes the square of the length of a special scheme's host when
 * it is made of many non-ASCII labels (ADR 0044), so a place that reads a URL
 * out of text a registry, a lock, a manifest or a network peer chose goes through
 * `parseUntrustedUrl` (`@openpacker/canonical`), which asks first. This finds
 * the places that do not. It does not recognise a call one spelling at a time;
 * it forbids the reference:
 *
 * - `new URL(...)` and `new <anything>.URL(...)`, `URL.canParse` and `URL.parse`;
 * - the name `URL` used as a value in any other way (`const U = URL`,
 *   `Reflect.construct(URL, ...)`, `[URL]`), and `import { URL }` under any name;
 * - `fileURLToPath(x)` unless `x` is `import.meta.url` or a call of a function
 *   that returns a URL that was read through the guard (`GUARDED`);
 * - a call of `fetch` and `new Request`, which parse the address they are given.
 *
 * `x instanceof URL`, a type annotation, and a member that happens to be called
 * `URL` are not uses.
 */

export interface UrlUse {
  /** The way a parser is reached. */
  how: string;
  /** The statement that does it, as written, on one line. */
  statement: string;
  line: number;
}

/**
 * Functions that return a `URL` that was read through the guard. `fileURLToPath`
 * of a call of one of these is not a parse of its own.
 */
export const GUARDED: ReadonlySet<string> = new Set([
  'parseUntrustedUrl',
  'assertReadableUrl',
  'providerLocation',
]);

/** Strips the wrappers that do not change what a value is. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isSatisfiesExpression(current)
    )
      current = current.expression;
    else return current;
  }
}

/** Whether a node sits in a type position, which names no value. */
function inTypePosition(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node; at !== undefined; at = at.parent) {
    if (ts.isTypeNode(at) || ts.isTypeAliasDeclaration(at)) return true;
    if (ts.isInterfaceDeclaration(at)) return true;
    if (ts.isStatement(at) || ts.isSourceFile(at)) return false;
  }
  return false;
}

/** The name a callee or constructor ends in, if it is a plain or dotted name. */
function endName(node: ts.Expression): string | undefined {
  const target = unwrap(node);
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return undefined;
}

export function findUrlUses(text: string, file = 'probe.ts'): UrlUse[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: UrlUse[] = [];
  const statementOf = (node: ts.Node): ts.Node => {
    let at: ts.Node = node;
    while (at.parent !== undefined && !ts.isStatement(at)) at = at.parent;
    return at;
  };
  const note = (how: string, node: ts.Node): void => {
    found.push({
      how,
      statement: statementOf(node).getText(source).replace(/\s+/gu, ' '),
      line:
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });
  };

  /** Nodes already counted as part of a larger use. */
  const consumed = new Set<ts.Node>();
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const callee = unwrap(node.expression);
      const name = endName(callee);
      if (name === 'URL') {
        consumed.add(callee);
        if (ts.isPropertyAccessExpression(callee)) consumed.add(callee.name);
        note('new URL', node);
      } else if (name === 'Request') note('new Request', node);
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (
        ts.isPropertyAccessExpression(callee) &&
        endName(callee.expression) === 'URL' &&
        (callee.name.text === 'canParse' || callee.name.text === 'parse')
      ) {
        consumed.add(unwrap(callee.expression));
        note(`URL.${callee.name.text}`, node);
      } else if (ts.isIdentifier(callee) && callee.text === 'fetch')
        note('fetch', node);
      else if (endName(callee) === 'fileURLToPath') {
        const argument = node.arguments[0];
        const inner = argument === undefined ? undefined : unwrap(argument);
        const guarded =
          inner !== undefined &&
          ((ts.isCallExpression(inner) &&
            GUARDED.has(endName(inner.expression) ?? '')) ||
            (ts.isPropertyAccessExpression(inner) &&
              inner.name.text === 'url' &&
              ts.isMetaProperty(unwrap(inner.expression))));
        if (!guarded) note('fileURLToPath', node);
      }
    }
    if (
      ts.isImportSpecifier(node) &&
      (node.propertyName ?? node.name).text === 'URL'
    )
      note('import { URL }', node);
    if (
      ts.isIdentifier(node) &&
      node.text === 'URL' &&
      !consumed.has(node) &&
      !inTypePosition(node)
    ) {
      const parent = node.parent;
      const isMember =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isQualifiedName(parent) && parent.right === node) ||
        ts.isImportSpecifier(parent) ||
        ts.isExportSpecifier(parent);
      const isInstanceof =
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
        parent.right === node;
      if (!isMember && !isInstanceof) note('URL as a value', node);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'URL' &&
      !consumed.has(node) &&
      !consumed.has(node.name) &&
      !inTypePosition(node)
    ) {
      const parent = node.parent;
      const isInstanceof =
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
        parent.right === node;
      if (!isInstanceof) note('.URL as a value', node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
