import ts from 'typescript';

/**
 * Finds what a source file writes to standard error, by the TypeScript parser.
 *
 * It follows the ways code reaches the stream that are not `io.stderr.write(x)`:
 * an alias of the stream (`const err = io.stderr`, `const { stderr } = process`),
 * a destructured or bound `write`, `stderr['write']`, `write.call(…)`,
 * `console.error` and `console.warn`, `fs.writeSync(2, …)` and
 * `child.stdout.pipe(process.stderr)`. A write is *routed* only when the whole
 * expression it writes is a call to `report(…)` or `formatFailure(…)`; a
 * `report(…) + raw` is not.
 */

export interface Written {
  /** The way the stream was reached. */
  how: string;
  /** What was written, as written, on one line. */
  argument: string;
  /** Whether the whole of it is a call to the one writer. */
  routed: boolean;
}

const ROUTES = new Set(['report', 'formatFailure']);

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

function nameOf(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isStringLiteralLike(node)) return node.text;
  return undefined;
}

/** The member a property or element access names, if it names one. */
function memberOf(node: ts.Expression): string | undefined {
  const target = unwrap(node);
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  if (ts.isElementAccessExpression(target))
    return nameOf(target.argumentExpression);
  return undefined;
}

function objectOf(node: ts.Expression): ts.Expression | undefined {
  const target = unwrap(node);
  if (
    ts.isPropertyAccessExpression(target) ||
    ts.isElementAccessExpression(target)
  )
    return target.expression;
  return undefined;
}

export function findStderrWrites(text: string, file = 'probe.ts'): Written[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const streams = new Set<string>(['stderr']);
  const writers = new Set<string>();

  const isStream = (node: ts.Expression): boolean => {
    const target = unwrap(node);
    if (ts.isIdentifier(target)) return streams.has(target.text);
    return memberOf(target) === 'stderr';
  };
  /** `<stream>.write`, however it is spelled. */
  const isWriteMember = (node: ts.Expression): boolean => {
    const object = objectOf(node);
    return (
      memberOf(node) === 'write' && object !== undefined && isStream(object)
    );
  };
  /** A value that is the stream's write function, bound or not. */
  const isWriteFunction = (node: ts.Expression): boolean => {
    const target = unwrap(node);
    if (isWriteMember(target)) return true;
    if (ts.isIdentifier(target)) return writers.has(target.text);
    if (ts.isCallExpression(target)) {
      const method = memberOf(target.expression);
      const object = objectOf(target.expression);
      return (
        (method === 'bind' || method === 'call' || method === 'apply') &&
        object !== undefined &&
        isWriteFunction(object)
      );
    }
    return false;
  };

  // Aliases first: declarations may come after the use that needs them in the
  // file, so settle them before looking at any call.
  const learn = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      const initializer = node.initializer;
      if (ts.isIdentifier(node.name) && initializer !== undefined) {
        if (isStream(initializer)) streams.add(node.name.text);
        if (isWriteFunction(initializer)) writers.add(node.name.text);
      }
      if (ts.isObjectBindingPattern(node.name) && initializer !== undefined) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const property = element.propertyName
            ? nameOf(element.propertyName)
            : element.name.text;
          if (property === 'stderr') streams.add(element.name.text);
          if (property === 'write' && isStream(initializer))
            writers.add(element.name.text);
        }
      }
    }
    ts.forEachChild(node, learn);
  };
  // Twice, so an alias of an alias is settled whichever way round they sit.
  learn(source);
  learn(source);

  const found: Written[] = [];
  const oneLine = (node: ts.Node | undefined): string =>
    (node?.getText(source) ?? '').replace(/\s+/gu, ' ');
  const record = (
    how: string,
    argument: ts.Expression | undefined,
    whole: ts.Node,
  ): void => {
    const written = argument ?? undefined;
    const target = written === undefined ? undefined : unwrap(written);
    const routed =
      target !== undefined &&
      ts.isCallExpression(target) &&
      ts.isIdentifier(target.expression) &&
      ROUTES.has(target.expression.text);
    found.push({
      how,
      argument: oneLine(written ?? whole),
      routed,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const method = memberOf(callee);
      const object = objectOf(callee);
      if (isWriteMember(callee))
        record('stream.write', node.arguments[0], node);
      else if (
        ts.isIdentifier(unwrap(callee)) &&
        writers.has((unwrap(callee) as ts.Identifier).text)
      )
        record('write function', node.arguments[0], node);
      else if (
        (method === 'call' || method === 'apply' || method === 'bind') &&
        object !== undefined &&
        isWriteFunction(object)
      )
        record(
          `write.${method}`,
          method === 'call' ? node.arguments[1] : undefined,
          node,
        );
      else if (
        object !== undefined &&
        ts.isIdentifier(unwrap(object)) &&
        (unwrap(object) as ts.Identifier).text === 'console' &&
        (method === 'error' || method === 'warn')
      )
        record(`console.${method}`, node.arguments[0], node);
      else if (
        method === 'writeSync' ||
        (ts.isIdentifier(unwrap(callee)) &&
          (unwrap(callee) as ts.Identifier).text === 'writeSync')
      ) {
        const descriptor = node.arguments[0];
        if (
          descriptor !== undefined &&
          (descriptor.getText(source) === '2' ||
            descriptor.getText(source).endsWith('.fd'))
        )
          record('writeSync(2)', node.arguments[1], node);
      } else if (
        method === 'pipe' &&
        node.arguments[0] !== undefined &&
        isStream(node.arguments[0])
      )
        record('pipe into stderr', undefined, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
