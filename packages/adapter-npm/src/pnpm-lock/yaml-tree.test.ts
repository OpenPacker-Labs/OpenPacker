import { Lexer, parseDocument, visit } from 'yaml';
import { describe, expect, it } from 'vitest';
import { PnpmLockError, type PnpmLockReason } from './errors.js';
import { FIXTURES, fixtureText } from './fixture-support.js';
import { DEFAULT_PNPM_LOCK_LIMITS, resolvePnpmLockLimits } from './limits.js';
import {
  LEXEMES_PER_NODE,
  readYamlTree,
  type YamlMap,
  type YamlValue,
} from './yaml-tree.js';

const read = (text: string, limits = DEFAULT_PNPM_LOCK_LIMITS) =>
  readYamlTree(text, limits);

function refusal(
  text: string,
  limits = DEFAULT_PNPM_LOCK_LIMITS,
): PnpmLockError {
  try {
    read(text, limits);
  } catch (error) {
    if (error instanceof PnpmLockError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const reasonOf = (text: string, limits = DEFAULT_PNPM_LOCK_LIMITS) =>
  refusal(text, limits).reason as PnpmLockReason;

const asMap = (value: YamlValue): YamlMap => {
  if (!(value instanceof Map)) throw new Error('expected a map');
  return value;
};

describe('readYamlTree: what pnpm writes', () => {
  it('reads block and flow mappings, lists, quoted and plain scalars', () => {
    const tree = asMap(
      read(
        [
          "lockfileVersion: '9.0'",
          '',
          'settings:',
          '  autoInstallPeers: true',
          '  peersSuffixMaxLength: 1000',
          '',
          'packages:',
          '',
          "  '@scope/name@1.0.0':",
          '    resolution: {integrity: sha512-AAAA}',
          "    engines: {node: '>=8'}",
          '    cpu: [x64, arm64]',
          '    deprecated: use "other" instead',
          '    peerDependenciesMeta:',
          '      react:',
          '        optional: true',
          '    bundledDependencies:',
          '      - a',
          '      - b',
          '',
          '  nothing@1.0.0: {}',
          '',
        ].join('\n'),
      ),
    );
    expect(asMap(tree.get('settings')!).get('peersSuffixMaxLength')).toBe(1000);
    const packages = asMap(tree.get('packages')!);
    const scoped = asMap(packages.get('@scope/name@1.0.0')!);
    expect(asMap(scoped.get('resolution')!).get('integrity')).toBe(
      'sha512-AAAA',
    );
    expect(scoped.get('cpu')).toEqual(['x64', 'arm64']);
    expect(scoped.get('bundledDependencies')).toEqual(['a', 'b']);
    expect(asMap(scoped.get('peerDependenciesMeta')!)).toEqual(
      new Map([['react', new Map([['optional', true]])]]),
    );
    expect(packages.get('nothing@1.0.0')).toEqual(new Map());
    expect(tree.get('lockfileVersion')).toBe('9.0');
  });

  it('reads the flow mappings Prettier breaks over several lines', () => {
    const tree = asMap(
      read(
        [
          'packages:',
          '  a@1.0.0:',
          '    resolution:',
          '      {',
          '        integrity: sha512-AAAA,',
          '      }',
          "    engines: { node: '>=8' }",
        ].join('\n'),
      ),
    );
    const a = asMap(asMap(tree.get('packages')!).get('a@1.0.0')!);
    expect(asMap(a.get('resolution')!).get('integrity')).toBe('sha512-AAAA');
  });

  it('reads a block scalar and a value pnpm quoted because it looks like a number', () => {
    const tree = asMap(read("deprecated: |-\n  one\n  two\nversion: '1.10'\n"));
    expect(tree.get('deprecated')).toBe('one\ntwo');
    expect(tree.get('version')).toBe('1.10');
  });

  it('keeps file order and treats __proto__ as a key like any other', () => {
    const tree = asMap(read('b: 1\n__proto__: 2\nconstructor: 3\na: 4\n'));
    expect([...tree.keys()]).toEqual(['b', '__proto__', 'constructor', 'a']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('accepts comments, and a text with no trailing newline', () => {
    const tree = asMap(read('# note\na: 1 # trailing\nb: [x, y]'));
    expect(tree.get('a')).toBe(1);
  });
});

describe('readYamlTree: what it refuses', () => {
  it('refuses an anchor, an alias and a merge key, and never expands them', () => {
    expect(reasonOf('a: &x {b: 1}\nc: 2\n')).toBe('yaml-feature');
    const aliased = refusal('a: &x {b: 1}\nc: *x\n');
    expect(aliased.reason).toBe('yaml-feature');
    expect(aliased.message).toContain('anchor (&x)');
    expect(reasonOf('a: &x {b: 1}\nc:\n  <<: *x\n')).toBe('yaml-feature');
    // Each level names the one before it three times: 3^10 values if expanded.
    const bomb = [
      'a0: &a0 [x, x, x]',
      ...Array.from(
        { length: 10 },
        (_, i) => `a${i + 1}: &a${i + 1} [*a${i}, *a${i}, *a${i}]`,
      ),
    ].join('\n');
    expect(reasonOf(bomb)).toBe('yaml-feature');
  });

  it('names the line of the first refusal', () => {
    expect(refusal('a: 1\nb: 2\nc: *x\n').message).toContain('line 3');
  });

  it('refuses a tag', () => {
    expect(reasonOf('a: !!str 1\n')).toBe('yaml-feature');
    expect(reasonOf('a: !custom x\n')).toBe('yaml-feature');
    expect(reasonOf('%TAG !e! tag:example.com,2000:\n---\na: !e!x 1\n')).toBe(
      'yaml-feature',
    );
  });

  it.each([
    ['%YAML 1.2', '%YAML'],
    ['%YAML 1.1', '%YAML'],
    ['%TAG ! tag:example.com,2000:', '%TAG'],
    ['%TAG !e! tag:example.com,2000:', '%TAG'],
    // Redefining the default handle leaves one handle, as having none does.
    ['%TAG !! tag:example.com,2000:', '%TAG'],
    ['%TAG !! tag:yaml.org,2002:', '%TAG'],
    ['%FOO bar', '%FOO'],
  ])('refuses the directive %s, though nothing uses it', (directive, name) => {
    const error = refusal(`${directive}\n---\na: 1\n`);
    expect(error.reason).toBe('yaml-feature');
    expect(error.message).toContain(`the directive ${name}`);
    expect(error.message).toContain('line 1');
  });

  it('refuses a directive that has no document after it', () => {
    expect(reasonOf('%YAML 1.2\n')).toBe('yaml-feature');
  });

  it('accepts the document markers, which are not directives', () => {
    expect(() => read('---\na: 1\n')).not.toThrow();
    expect(() => read('---\na: 1\n...\n')).not.toThrow();
  });

  it('refuses several documents and an empty text', () => {
    expect(reasonOf('a: 1\n---\nb: 2\n')).toBe('yaml-syntax');
    expect(reasonOf('')).toBe('yaml-syntax');
  });

  it('refuses a key listed twice, in block and flow mappings and nested', () => {
    const block = refusal('a: 1\nb: 2\na: 3\n');
    expect(block.reason).toBe('duplicate-key');
    expect(block.message).toContain('"a"');
    expect(block.message).toContain('line 3');
    expect(reasonOf('a: {x: 1, x: 2}\n')).toBe('duplicate-key');
    expect(reasonOf('p:\n  q@1.0.0: {}\n  q@1.0.0: {}\n')).toBe(
      'duplicate-key',
    );
    // The same key in two different mappings is not a repeat.
    expect(() => read('a: {x: 1}\nb: {x: 2}\n')).not.toThrow();
  });

  it('refuses a key that is not a string, because pnpm quotes those', () => {
    expect(reasonOf('123: a\n')).toBe('shape');
    expect(reasonOf('true: a\n')).toBe('shape');
    expect(reasonOf('9.0: a\n')).toBe('shape');
    expect(reasonOf('null: a\n')).toBe('shape');
    expect(() => read("'123': a\n")).not.toThrow();
    expect(reasonOf('? [1, 2]\n: a\n')).toBe('yaml-syntax');
  });

  it('reads a key of any length in the explicit form, as pnpm writes one', () => {
    const key = 'k'.repeat(1500);
    const tree = asMap(read(`top:\n  ? ${key}\n  : a: 1\n`));
    expect([...asMap(tree.get('top')!).keys()]).toEqual([key]);
    expect(() => read(`top:\n  ? '${key}'\n  : a: 1\n`)).not.toThrow();
  });

  it('says what is wrong with a key over 1024 characters on one line', () => {
    for (const key of [`'${'k'.repeat(1100)}'`, 'k'.repeat(1100)]) {
      const error = refusal(`top:\n  ${key}:\n    a: 1\n`);
      expect(error.reason).toBe('yaml-syntax');
      expect(error.message).toContain('more than 1024 characters');
      expect(error.message).toContain('explicit form');
      expect(error.message).toContain('line 2');
    }
  });

  it('refuses text that is not YAML, with the line', () => {
    const error = refusal('a:\n\tb: 1\n');
    expect(error.reason).toBe('yaml-syntax');
    expect(error.message).toContain('line 2');
    expect(reasonOf('a: [1, 2\n')).toBe('yaml-syntax');
    expect(reasonOf('a: "unterminated\n')).toBe('yaml-syntax');
  });

  it('refuses characters YAML forbids', () => {
    expect(refusal('a: "x\u0000y"\n').reason).toBe('encoding');
    expect(reasonOf('a: "x\u0007y"\n')).toBe('encoding');
    expect(reasonOf('a: "x\u0086y"\n')).toBe('encoding');
    expect(() => read('a: "x\u0085y"\n')).not.toThrow();
    expect(reasonOf('a: "x\ud800y"\n')).toBe('encoding');
    expect(() => read('a: "tab\there"\n')).not.toThrow();
  });

  it('refuses a merge conflict by name', () => {
    const text = 'a: 1\n<<<<<<< HEAD\nb: 2\n=======\nb: 3\n>>>>>>> feature\n';
    const error = refusal(text);
    expect(error.reason).toBe('conflict-markers');
    expect(error.message).toContain('line 2');
  });
});

describe('readYamlTree: bounds', () => {
  const small = (over: Parameters<typeof resolvePnpmLockLimits>[0]) =>
    resolvePnpmLockLimits(over);

  it('refuses text over maxBytes, counting bytes and not characters', () => {
    const text = 'a: "' + 'é'.repeat(30) + '"\n';
    expect(() => read(text, small({ maxBytes: 70 }))).not.toThrow();
    expect(reasonOf(text, small({ maxBytes: 60 }))).toBe('too-large');
  });

  it('refuses a megabyte of open brackets at maxDepth, without building them', () => {
    const started = Date.now();
    expect(reasonOf('a: ' + '['.repeat(1_000_000))).toBe('limit');
    expect(reasonOf('a: ' + '{a: '.repeat(100_000))).toBe('limit');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  /** Text whose deepest scalar has `depth` collections above it, the top mapping being the first. */
  const NESTED = {
    'block mappings': (depth: number) =>
      [
        ...Array.from(
          { length: depth - 1 },
          (_, i) => `${' '.repeat(i)}k${i}:`,
        ),
        `${' '.repeat(depth - 1)}v: 1`,
      ].join('\n'),
    'block sequences': (depth: number) =>
      [
        ...Array.from({ length: depth - 1 }, (_, i) => `${' '.repeat(i)}-`),
        `${' '.repeat(depth - 1)}- 1`,
      ].join('\n'),
    'flow sequences': (depth: number) =>
      `a: ${'['.repeat(depth - 1)}1${']'.repeat(depth - 1)}`,
    'flow mappings': (depth: number) =>
      `a: ${'{a: '.repeat(depth - 1)}1${'}'.repeat(depth - 1)}`,
  };

  it.each(Object.entries(NESTED))(
    'accepts %s down to maxDepth and refuses one level more',
    (_kind, nested) => {
      for (const maxDepth of [3, DEFAULT_PNPM_LOCK_LIMITS.maxDepth]) {
        const limits = small({ maxDepth });
        expect(() => read(nested(maxDepth), limits)).not.toThrow();
        const error = refusal(nested(maxDepth + 1), limits);
        expect(error.reason).toBe('limit');
        expect(error.message).toContain(
          `${maxDepth + 1} levels of nesting, more than the limit of ${maxDepth}`,
        );
      }
    },
  );

  it('refuses block nesting deeper than maxDepth', () => {
    const nested = Array.from(
      { length: 40 },
      (_, i) => `${' '.repeat(i)}k${i}:`,
    ).join('\n');
    expect(reasonOf(`${nested}\n${' '.repeat(40)}v: 1\n`)).toBe('limit');
    const shallow = Array.from(
      { length: 6 },
      (_, i) => `${' '.repeat(i)}k${i}:`,
    ).join('\n');
    expect(() => read(`${shallow}\n${' '.repeat(6)}v: 1\n`)).not.toThrow();
  });

  it('refuses more nodes than maxNodes', () => {
    const text = Array.from({ length: 100 }, (_, i) => `k${i}: ${i}`).join(
      '\n',
    );
    expect(() => read(text, small({ maxNodes: 201 }))).not.toThrow();
    const error = refusal(text, small({ maxNodes: 200 }));
    expect(error.reason).toBe('limit');
    expect(error.message).toContain('maxNodes');
  });

  describe('the lexeme budget, which counts what the node count cannot', () => {
    const lexemesOf = (text: string) => [...new Lexer().lex(text)].length;
    // A key and a value, then blank lines: two nodes and a hundred lexemes.
    const blank = `a: 1\n${'\n'.repeat(120)}`;

    it('refuses more lexemes than maxNodes times LEXEMES_PER_NODE, though the nodes are few', () => {
      const lexemes = lexemesOf(blank);
      const fits = Math.ceil(lexemes / LEXEMES_PER_NODE);
      expect(fits).toBeGreaterThan(2);
      expect(() => read(blank, small({ maxNodes: fits }))).not.toThrow();
      const error = refusal(
        blank,
        small({ maxNodes: Math.floor((lexemes - 1) / LEXEMES_PER_NODE) }),
      );
      expect(error.reason).toBe('limit');
      expect(error.message).toMatch(/has \d+ lexemes, more than the limit of/u);
      expect(error.message).toContain('maxNodes');
    });

    it('refuses empty list items and comments the same way', () => {
      const limits = small({ maxNodes: 40 });
      expect(reasonOf(`x:\n${'  -\n'.repeat(400)}`, limits)).toBe('limit');
      expect(reasonOf(`x: 1\n${'#\n'.repeat(400)}`, limits)).toBe('limit');
    });

    it('is more than the real locks need, by a third', () => {
      for (const name of FIXTURES) {
        const text = fixtureText(name);
        let nodes = 0;
        visit(parseDocument(text, { uniqueKeys: false }), {
          Node() {
            nodes += 1;
          },
        });
        const perNode = lexemesOf(text) / nodes;
        expect(perNode, name).toBeLessThan(4);
        expect(perNode * 1.25, name).toBeLessThan(LEXEMES_PER_NODE);
      }
    });
  });

  it('refuses a key or a string over its length', () => {
    expect(
      reasonOf(`${'k'.repeat(20)}: 1\n`, small({ maxKeyLength: 10 })),
    ).toBe('limit');
    expect(
      reasonOf(`k: ${'v'.repeat(20)}\n`, small({ maxStringLength: 10 })),
    ).toBe('limit');
  });

  it('refuses a bound that is not a positive integer', () => {
    expect(() => resolvePnpmLockLimits({ maxBytes: 0 })).toThrow(PnpmLockError);
    expect(() => resolvePnpmLockLimits({ maxNodes: 1.5 })).toThrow(/maxNodes/u);
  });
});
