import ts from 'typescript';

/**
 * Finds every way a source file reaches a standard-error stream, by the
 * TypeScript parser.
 *
 * It does not recognise write calls one spelling at a time. It forbids the
 * reference: a property or element access that names `stderr`, an identifier
 * called `stderr` (a binding, a parameter, an import, a shorthand property), a
 * computed key on `io` or `process`, `console` in any form and `new Console`,
 * `process.emitWarning`, and a file descriptor 2 (`/dev/stderr`, `fd` of a
 * stream) handed to a `fs` call. A stream passed as an argument, kept in a
 * variable, put in an array or an object, bound, applied, called through
 * `Reflect` or reached through a conditional is named by the property that
 * reached it, so each of those is found where the stream is first named.
 *
 * One form is allowed, and recorded as *routed*: `io.stderr.write(x)` where the
 * whole of `x` is a call to `report` or `formatFailure`, the one writer
 * (`error-report.ts`), imported and not declared in the same file. Type
 * declarations (`stderr: Pick<WriteStream, 'write'>`) name no stream and are not
 * references.
 */

export interface Use {
  /** The way the stream was reached. */
  how: string;
  /**
   * For a write, what was written; otherwise the statement that names the
   * stream. As written, on one line.
   */
  argument: string;
  /** Whether it is the one allowed form. */
  routed: boolean;
}

const ROUTES = new Set(['report', 'formatFailure']);
/** The objects a stream is reached through. */
const STREAM_HOLDERS = /(^|\.)(io|process|host|streams?)$/u;
/** `fs` calls that take a descriptor or a path to write to. */
const DESCRIPTOR_CALLS = new Set([
  'writeSync',
  'writeFileSync',
  'appendFileSync',
  'write',
  'writeFile',
  'appendFile',
  'createWriteStream',
  'openSync',
  'open',
]);
const STDERR_PATHS = new Set(['/dev/stderr', '/dev/fd/2', '/proc/self/fd/2']);

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

/** Whether an identifier only names a member, so it names no value itself. */
function isMemberName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isMethodSignature(parent) && parent.name === node) ||
    (ts.isQualifiedName(parent) && parent.right === node)
  );
}

export function findStderrUses(text: string, file = 'probe.ts'): Use[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: Use[] = [];
  const oneLine = (node: ts.Node): string =>
    node.getText(source).replace(/\s+/gu, ' ');
  const statementOf = (node: ts.Node): ts.Node => {
    let at: ts.Node = node;
    while (at.parent !== undefined && !ts.isStatement(at)) at = at.parent;
    return at;
  };
  const note = (how: string, node: ts.Node, argument = statementOf(node)) =>
    found.push({ how, argument: oneLine(argument), routed: false });

  // `report` and `formatFailure` count only when they are the imported writer.
  const declaredHere = new Set<string>();
  const declared = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isVariableDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      ROUTES.has(node.name.text) &&
      !ts.isSourceFile(node)
    )
      declaredHere.add(node.name.text);
    ts.forEachChild(node, declared);
  };
  declared(source);
  const isRoute = (node: ts.Expression): boolean => {
    const target = unwrap(node);
    return (
      ts.isCallExpression(target) &&
      ts.isIdentifier(target.expression) &&
      ROUTES.has(target.expression.text) &&
      !declaredHere.has(target.expression.text)
    );
  };

  /** `<x>.stderr.write(argument)` and the node of `<x>.stderr`. */
  const asWrite = (
    call: ts.CallExpression,
  ): { stream: ts.Node; argument?: ts.Expression } | undefined => {
    const callee = unwrap(call.expression);
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'write')
      return undefined;
    const stream = unwrap(callee.expression);
    if (!ts.isPropertyAccessExpression(stream) || stream.name.text !== 'stderr')
      return undefined;
    return {
      stream,
      ...(call.arguments[0] && { argument: call.arguments[0] }),
    };
  };

  const consumed = new Set<ts.Node>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const write = asWrite(node);
      if (write !== undefined) {
        consumed.add(write.stream);
        const routed =
          write.argument !== undefined &&
          node.arguments.length === 1 &&
          isRoute(write.argument);
        found.push({
          how: 'stream.write',
          argument: oneLine(write.argument ?? node),
          routed,
        });
      } else {
        const callee = unwrap(node.expression);
        const name = ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ts.isIdentifier(callee)
            ? callee.text
            : undefined;
        if (name === 'emitWarning') note('emitWarning', node);
        const first = node.arguments[0];
        if (
          name !== undefined &&
          DESCRIPTOR_CALLS.has(name) &&
          first !== undefined
        ) {
          const shown = first.getText(source);
          if (shown === '2' || shown.endsWith('.fd'))
            note(`${name}(descriptor 2)`, node);
        }
      }
    }
    if (ts.isNewExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee) && callee.text === 'Console')
        note('new Console', node);
    }
    if (ts.isPropertyAccessExpression(node) && !consumed.has(node)) {
      if (node.name.text === 'stderr' && !inTypePosition(node))
        note('.stderr', node);
    }
    if (ts.isElementAccessExpression(node) && !inTypePosition(node)) {
      const key = node.argumentExpression;
      const holder = oneLine(node.expression);
      if (ts.isStringLiteralLike(key)) {
        if (key.text === 'stderr') note("['stderr']", node);
      } else if (!ts.isNumericLiteral(key) && STREAM_HOLDERS.test(holder))
        note(`${holder}[computed]`, node);
    }
    if (ts.isStringLiteralLike(node) && STDERR_PATHS.has(node.text))
      note(`path ${node.text}`, node);
    if (ts.isIdentifier(node) && !isMemberName(node) && !inTypePosition(node)) {
      if (/^stderr$/iu.test(node.text)) note('stderr binding', node);
      else if (node.text === 'console') note('console', node);
      else if (node.text === 'Console') note('Console', node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
