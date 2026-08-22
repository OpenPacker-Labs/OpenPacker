import { defineRule } from '@oxlint/plugins';

import type { ESTree } from '@oxlint/plugins';

type RuntimeFunction = ESTree.ArrowFunctionExpression | ESTree.Function;

function isRuntimeFunction(node: ESTree.Node): node is RuntimeFunction {
  return (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression'
  );
}

function isInsideTypeGuard(node: ESTree.Node): boolean {
  let current: ESTree.Node | null = node.parent;
  while (current !== null && current.type !== 'Program') {
    if (isRuntimeFunction(current)) {
      return current.returnType?.typeAnnotation.type === 'TSTypePredicate';
    }
    current = current.parent;
  }
  return false;
}

function hasDeclaredType(node: ESTree.Expression): boolean {
  if (node.type !== 'Identifier') return false;
  let current: ESTree.Node | null = node.parent;
  while (current !== null && current.type !== 'Program') {
    if (
      current.type === 'VariableDeclarator' &&
      current.id.type === 'Identifier' &&
      current.id.name === node.name
    )
      return (
        current.id.typeAnnotation?.typeAnnotation.type !== 'TSUnknownKeyword'
      );
    if (isRuntimeFunction(current)) {
      const parameter = current.params.find(
        (candidate) =>
          candidate.type === 'Identifier' && candidate.name === node.name,
      );
      if (parameter?.type === 'Identifier')
        return (
          parameter.typeAnnotation?.typeAnnotation.type !== 'TSUnknownKeyword'
        );
    }
    current = current.parent;
  }
  return false;
}

function isPublicContext(node: ESTree.Node): boolean {
  let current: ESTree.Node | null = node.parent;
  while (current !== null && current.type !== 'Program') {
    if (current.type === 'ExportNamedDeclaration') return true;
    if (current.type === 'ClassBody') return true;
    if (
      current.type === 'FunctionDeclaration' ||
      current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression'
    )
      return false;
    current = current.parent;
  }
  return false;
}

/** Disallow runtime typeof checks that narrow unparsed values instead of decoding them. */
export const noRuntimeTypeofRule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow runtime typeof checks; external values must be decoded into meaningful types at their I/O boundary.',
    },
    messages: {
      runtimeTypeof:
        'A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowInTypeGuards: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ allowInTypeGuards: false }],
  },
  createOnce(context) {
    return {
      UnaryExpression(node) {
        const option = context.options?.[0];
        const allowInTypeGuards =
          typeof option === 'object' &&
          option !== null &&
          !Array.isArray(option) &&
          option.allowInTypeGuards === true;
        if (
          node.operator === 'typeof' &&
          isPublicContext(node) &&
          !hasDeclaredType(node.argument) &&
          (!allowInTypeGuards || !isInsideTypeGuard(node))
        ) {
          context.report({ node, messageId: 'runtimeTypeof' });
        }
      },
    };
  },
});
