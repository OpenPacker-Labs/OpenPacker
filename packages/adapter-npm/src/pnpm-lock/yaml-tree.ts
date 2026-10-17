/**
 * `pnpm-lock.yaml` text as a tree of strings, numbers, booleans, `null`, maps
 * and lists, and nothing else.
 *
 * pnpm writes a small, regular subset of YAML: block mappings, block
 * sequences, flow `{}` and `[]` for short values, single-quoted and plain
 * scalars, and no comments, anchors, tags or directives. This reads exactly
 * that subset through the `yaml` library (ADR 0030: a mature parser, not our
 * own) and refuses the rest, before anything is built from it.
 *
 * Three things the library does not do for us, done here:
 *
 * - **Bound the work before it is done.** The text goes through the library's
 *   lexer and parser one lexeme at a time, and the parser's own stack is
 *   watched, so a megabyte of `[` is refused at depth `maxDepth` instead of
 *   building a million nested tokens first (measured: `parseDocument` on that
 *   input takes 3 s and 916 MB of resident memory before it reports
 *   RESOURCE_EXHAUSTION).
 * - **Refuse repeated keys in linear time.** `uniqueKeys: true` compares each
 *   key with every earlier one (40,000 packages took 50 s against 3 s without
 *   it), so the library's check is off and the walk looks each key up in the map it is building.
 * - **Keep keys strings.** A key `123:` is a number to YAML's core schema.
 *   pnpm quotes such keys, so an unquoted one was not written by pnpm.
 *
 * Maps are `Map`s in file order, so a key such as `__proto__` is data.
 */

import { quote } from '@openpacker/adapter-core';
import {
  Composer,
  Lexer,
  Parser,
  isMap,
  isNode,
  isScalar,
  isSeq,
  type CST,
  type Document,
  type Node,
} from 'yaml';
import { PnpmLockError } from './errors.js';
import { checkLimit, type PnpmLockLimits } from './limits.js';

export type YamlScalar = string | number | boolean | null;
export type YamlMap = ReadonlyMap<string, YamlValue>;
export type YamlList = readonly YamlValue[];
export type YamlValue = YamlScalar | YamlMap | YamlList;

/**
 * Where the first character is that YAML 1.2 does not allow (`c-printable`:
 * tab, line feeds, U+0020 to U+007E, U+0085, U+00A0 up, minus lone surrogates
 * and U+FFFE/U+FFFF), or -1. The library lets some of them through.
 */
function forbiddenAt(text: string): number {
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code >= 0x20 && code <= 0x7e) continue;
    if (code === 0x09 || code === 0x0a || code === 0x0d || code === 0x85)
      continue;
    if ((code >= 0xa0 && code < 0xd800) || (code >= 0xe000 && code <= 0xfffd))
      continue;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(at + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        at += 1;
        continue;
      }
    }
    return at;
  }
  return -1;
}
const CONFLICT_MARKER = /^(?:<{7}|>{7})(?: |$)/mu;

/**
 * Lexemes the lexer may produce per node allowed; the walk below counts nodes
 * exactly. The four real locks cost 3.4 lexemes a node and the same lock
 * reformatted by Prettier 3.6 (or wrapped at 40 columns) 3.8, so 5 leaves a third
 * to spare. What the budget is for is input that is mostly lexemes and hardly any
 * nodes (blank lines, comments, empty list items), which costs memory all the same.
 */
export const LEXEMES_PER_NODE = 5;

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let at = text.indexOf('\n'); at !== -1 && at < offset; ) {
    line += 1;
    at = text.indexOf('\n', at + 1);
  }
  return line;
}

function syntax(text: string, offset: number, message: string): PnpmLockError {
  return new PnpmLockError(
    'yaml-syntax',
    `is not valid YAML: ${message} (line ${lineOf(text, offset)})`,
  );
}

function feature(text: string, offset: number, what: string): PnpmLockError {
  return new PnpmLockError(
    'yaml-feature',
    `uses ${what}, which pnpm does not write and this does not read (line ${lineOf(text, offset)})`,
  );
}

/** Bytes, characters YAML forbids, and conflict markers: the checks that need no parser. */
function checkText(text: string, limits: PnpmLockLimits): void {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > limits.maxBytes)
    throw new PnpmLockError(
      'too-large',
      `is ${bytes} bytes, more than the limit of ${limits.maxBytes} (maxBytes)`,
    );
  const bad = forbiddenAt(text);
  if (bad !== -1)
    throw new PnpmLockError(
      'encoding',
      `holds the character U+${(text.codePointAt(bad) ?? 0).toString(16).toUpperCase().padStart(4, '0')} (line ${lineOf(text, bad)}), which YAML does not allow`,
    );
  const marker = text.search(CONFLICT_MARKER);
  if (marker !== -1)
    throw new PnpmLockError(
      'conflict-markers',
      `holds an unresolved merge conflict (line ${lineOf(text, marker)}); resolve it and run pnpm install`,
    );
}

/**
 * The tokens as they are, but a directive (`%YAML`, `%TAG`, anything else that
 * starts with `%`) is refused. It is checked where the parser yields it, because
 * afterwards the document cannot tell a `%TAG !! ...` that redefines the default
 * handle from no directive at all.
 */
function* refuseDirectives(
  text: string,
  tokens: Iterable<CST.Token>,
): Generator<CST.Token> {
  for (const token of tokens) {
    if (token.type === 'directive')
      throw feature(
        text,
        token.offset,
        `the directive ${token.source.split(/\s/u, 1)[0] ?? '%'}`,
      );
    yield token;
  }
}

/**
 * The document, composed from a lexer and parser that are stopped as soon as
 * the text nests deeper or runs longer than a lock may.
 */
function composeOne(text: string, limits: PnpmLockLimits): Document.Parsed {
  const lexer = new Lexer();
  const parser = new Parser();
  const composer = new Composer({
    version: '1.2',
    uniqueKeys: false,
    prettyErrors: false,
  });
  let lexemes = 0;
  const lexemeLimit = limits.maxNodes * LEXEMES_PER_NODE;
  function* tokens() {
    for (const lexeme of lexer.lex(text)) {
      lexemes += 1;
      checkLimit(lexemes, lexemeLimit, 'lexemes', 'maxNodes');
      yield* refuseDirectives(text, parser.next(lexeme));
      checkLimit(
        parser.stack.length,
        limits.maxDepth + 3,
        'levels of nesting',
        'maxDepth',
      );
    }
    yield* refuseDirectives(text, parser.end());
  }
  const documents: Document.Parsed[] = [];
  try {
    for (const document of composer.compose(tokens())) {
      documents.push(document);
      if (documents.length > 1)
        throw new PnpmLockError(
          'yaml-syntax',
          "must be one YAML document, and this has several (pnpm 11 writes the lock of the project's config dependencies as a document ahead of the project lock; this reads only the project lock)",
        );
    }
  } catch (error) {
    if (error instanceof PnpmLockError) throw error;
    if (error instanceof RangeError)
      throw new PnpmLockError(
        'limit',
        'nests deeper than the YAML reader can follow',
        '',
        'maxDepth',
      );
    throw error;
  }
  const document = documents[0];
  if (document === undefined)
    throw new PnpmLockError('yaml-syntax', 'is empty');
  return document;
}

interface WalkState {
  readonly text: string;
  readonly limits: PnpmLockLimits;
  nodes: number;
}

function offsetOf(node: Node | null | undefined): number {
  return node?.range?.[0] ?? 0;
}

function countNode(state: WalkState): void {
  state.nodes += 1;
  checkLimit(state.nodes, state.limits.maxNodes, 'YAML nodes', 'maxNodes');
}

/** Anchors and tags change what a node means; pnpm writes neither. */
function refuseAnchorAndTag(state: WalkState, node: Node): void {
  if (node.anchor !== undefined)
    throw feature(
      state.text,
      offsetOf(node),
      `an anchor ${quote(`&${node.anchor}`)}`,
    );
  if (node.tag !== undefined)
    throw feature(state.text, offsetOf(node), `the tag ${node.tag}`);
}

function walkKey(state: WalkState, key: unknown): string {
  if (!isScalar(key))
    throw syntax(
      state.text,
      offsetOf(isNode(key) ? key : null),
      'a mapping key that is not a plain or quoted string',
    );
  countNode(state);
  refuseAnchorAndTag(state, key);
  const value: unknown = key.value;
  if (typeof value !== 'string')
    throw new PnpmLockError(
      'shape',
      `has the mapping key ${String(value)} (line ${lineOf(state.text, offsetOf(key))}), which is not a string; pnpm quotes keys that look like numbers, booleans or null`,
    );
  checkLimit(
    value.length,
    state.limits.maxKeyLength,
    'characters in a key',
    'maxKeyLength',
  );
  return value;
}

function walkScalar(state: WalkState, node: Node, value: unknown): YamlScalar {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    checkLimit(
      value.length,
      state.limits.maxStringLength,
      'characters in a string',
      'maxStringLength',
    );
    return value;
  }
  throw syntax(
    state.text,
    offsetOf(node),
    'a value that is not a string, number, boolean or null',
  );
}

function walkValue(
  state: WalkState,
  node: Node | null,
  depth: number,
): YamlValue {
  if (node === null) return null;
  countNode(state);
  // An alias needs an anchor before it, and an anchor is refused where it is defined, so
  // none is met here; one that were would fall through to the last throw below.
  refuseAnchorAndTag(state, node);
  checkLimit(depth, state.limits.maxDepth, 'levels of nesting', 'maxDepth');
  if (isScalar(node)) return walkScalar(state, node, node.value);
  if (isMap(node)) {
    const map = new Map<string, YamlValue>();
    for (const pair of node.items) {
      const key = walkKey(state, pair.key);
      if (map.has(key))
        throw new PnpmLockError(
          'duplicate-key',
          `lists the key ${quote(key)} twice in one mapping (line ${lineOf(state.text, offsetOf(isNode(pair.key) ? pair.key : null))})`,
        );
      map.set(
        key,
        walkValue(state, isNode(pair.value) ? pair.value : null, depth + 1),
      );
    }
    return map;
  }
  if (isSeq(node)) {
    const list: YamlValue[] = [];
    for (const item of node.items)
      list.push(walkValue(state, isNode(item) ? item : null, depth + 1));
    return list;
  }
  throw syntax(state.text, offsetOf(node), 'an unsupported kind of node');
}

/** The one document in `text` as plain data, or a `PnpmLockError` naming what is wrong. */
export function readYamlTree(text: string, limits: PnpmLockLimits): YamlValue {
  checkText(text, limits);
  const document = composeOne(text, limits);
  const first = document.errors[0];
  if (first !== undefined)
    throw syntax(
      text,
      first.pos[0],
      first.code === 'KEY_OVER_1024_CHARS'
        ? 'a mapping key of more than 1024 characters written on one line; YAML allows that only in the explicit form (`? key`, then `: value`), which is how pnpm writes one'
        : (first.message.split('\n')[0] ?? first.code),
    );
  const warning = document.warnings[0];
  if (warning !== undefined)
    throw feature(
      text,
      warning.pos[0],
      warning.message.split('\n')[0] ?? warning.code,
    );
  return walkValue({ text, limits, nodes: 0 }, document.contents, 0);
}
