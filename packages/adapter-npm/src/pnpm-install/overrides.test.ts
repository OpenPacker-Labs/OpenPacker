import { describe, expect, it } from 'vitest';
import type { ManifestLists } from './fresh.js';
import { applyOverrides, parseSelector } from './overrides.js';

const lists = (
  over: Partial<Record<keyof ManifestLists, [string, string][]>>,
): ManifestLists => ({
  dependencies: new Map(over.dependencies),
  devDependencies: new Map(over.devDependencies),
  optionalDependencies: new Map(over.optionalDependencies),
  peerDependencies: new Map(over.peerDependencies),
});

describe('parseSelector', () => {
  it.each([
    ['foo', { name: 'foo' }],
    ['foo@^1.0.0', { name: 'foo', range: '^1.0.0' }],
    ['@s/foo', { name: '@s/foo' }],
    ['@s/foo@1', { name: '@s/foo', range: '1' }],
    ['bar>foo', { name: 'foo', parent: { name: 'bar' } }],
    [
      '@s/bar@2>@s/foo@^1',
      { name: '@s/foo', range: '^1', parent: { name: '@s/bar', range: '2' } },
    ],
    ['foo@>1.0.0', { name: 'foo', range: '>1.0.0' }],
    ['foo@1 || >2', { name: 'foo', range: '1 || >2' }],
    [
      'bar@1>foo@>=2 <3',
      { name: 'foo', range: '>=2 <3', parent: { name: 'bar', range: '1' } },
    ],
  ])('reads %s', (text, expected) => {
    expect(parseSelector(text)).toEqual(expected);
  });
});

describe('applyOverrides', () => {
  const manifest = lists({
    dependencies: [
      ['a', '^1.0.0'],
      ['b', '^2.0.0'],
    ],
    devDependencies: [['c', '3.0.0']],
    optionalDependencies: [['d', '^4.0.0']],
    peerDependencies: [['a', '^1.0.0']],
  });

  it('changes a dependency in whichever list it is in, and nothing else', () => {
    const out = applyOverrides(
      manifest,
      new Map([
        ['a', 'workspace:*'],
        ['c', 'link:../c'],
        ['d', 'npm:other@1'],
      ]),
      {},
    );
    expect([...out.dependencies]).toEqual([
      ['a', 'workspace:*'],
      ['b', '^2.0.0'],
    ]);
    expect([...out.devDependencies]).toEqual([['c', 'link:../c']]);
    expect([...out.optionalDependencies]).toEqual([['d', 'npm:other@1']]);
    // A peer is overridden too, as pnpm does; `workspace:` is a peer range to it.
    expect([...out.peerDependencies]).toEqual([['a', 'workspace:*']]);
  });

  it('applies name@range only to a dependency that asks for that range', () => {
    const out = applyOverrides(
      manifest,
      new Map([
        ['a@^9.0.0', '9.9.9'],
        ['b@^2.0.0', '2.9.9'],
      ]),
      {},
    );
    expect(out.dependencies.get('a')).toBe('^1.0.0');
    expect(out.dependencies.get('b')).toBe('2.9.9');
  });

  it('drops a dependency overridden with -', () => {
    const out = applyOverrides(manifest, new Map([['b', '-']]), {});
    expect(out.dependencies.has('b')).toBe(false);
  });

  it('applies parent>name only to the importer of that name', () => {
    const overrides = new Map([['me>b', '2.9.9']]);
    expect(
      applyOverrides(manifest, overrides, { name: 'me' }).dependencies.get('b'),
    ).toBe('2.9.9');
    expect(
      applyOverrides(manifest, overrides, { name: 'you' }).dependencies.get(
        'b',
      ),
    ).toBe('^2.0.0');
    expect(applyOverrides(manifest, overrides, {}).dependencies.get('b')).toBe(
      '^2.0.0',
    );
  });

  it('returns the manifest it was given when there is nothing to apply', () => {
    expect(applyOverrides(manifest, new Map(), {})).toBe(manifest);
  });
});

describe('applyOverrides, as pnpm 10 applies overrides', () => {
  const manifest = lists({
    dependencies: [['left-pad', '^1.2.0']],
    peerDependencies: [['react', '^18.0.0']],
  });
  const pad = (out: ManifestLists) => out.dependencies.get('left-pad');

  it('applies name@range when the ranges intersect, not only when they are equal', () => {
    for (const selector of ['left-pad@^1.0.0', 'left-pad@<2', 'left-pad@1.x'])
      expect(
        pad(applyOverrides(manifest, new Map([[selector, '1.3.0']]), {})),
        selector,
      ).toBe('1.3.0');
    expect(
      pad(
        applyOverrides(manifest, new Map([['left-pad@^2.0.0', '2.0.0']]), {}),
      ),
    ).toBe('^1.2.0');
  });

  it("applies parent@range>name when the importer's version satisfies the range", () => {
    const overrides = new Map([['app@^1>left-pad', '1.3.0']]);
    const at = (version: string) =>
      pad(applyOverrides(manifest, overrides, { name: 'app', version }));
    expect(at('1.4.0')).toBe('1.3.0');
    expect(at('2.0.0')).toBe('^1.2.0');
  });

  it('prefers a parent selector to a plain one', () => {
    const overrides = new Map([
      ['left-pad', '9.0.0'],
      ['app>left-pad', '1.3.0'],
    ]);
    expect(pad(applyOverrides(manifest, overrides, { name: 'app' }))).toBe(
      '1.3.0',
    );
  });

  it("picks among selectors that all apply by pnpm's own comparator, so the order written decides", () => {
    const pick = (entries: [string, string][]) =>
      pad(applyOverrides(manifest, new Map(entries), {}));
    expect(
      pick([
        ['left-pad', 'plain'],
        ['left-pad@^1', 'ranged'],
      ]),
    ).toBe('ranged');
    expect(
      pick([
        ['left-pad@^1', 'ranged'],
        ['left-pad', 'plain'],
      ]),
    ).toBe('plain');
  });

  it('moves a peer to dependencies when the replacement is not a peer range', () => {
    const moved = applyOverrides(
      manifest,
      new Map([['react', 'npm:preact@10']]),
      {},
    );
    expect(moved.peerDependencies.get('react')).toBe('^18.0.0');
    expect(moved.dependencies.get('react')).toBe('npm:preact@10');
    const ranged = applyOverrides(
      manifest,
      new Map([['react', '^18.3.0']]),
      {},
    );
    expect(ranged.peerDependencies.get('react')).toBe('^18.3.0');
  });

  it('writes a file: or link: replacement relative to the importer', () => {
    const overrides = new Map([['left-pad', 'link:./vendor/left-pad']]);
    expect(pad(applyOverrides(manifest, overrides, { dir: '' }))).toBe(
      'link:vendor/left-pad',
    );
    expect(
      pad(applyOverrides(manifest, overrides, { dir: 'packages/web' })),
    ).toBe('link:../../vendor/left-pad');
  });

  it('does not guess at a range opm reads differently from pnpm: it is a doubt', () => {
    const doubts: string[] = [];
    const out = applyOverrides(
      manifest,
      new Map([['left-pad@v1.x', '1.3.0']]),
      {},
      doubts,
    );
    expect(pad(out)).toBe('^1.2.0');
    expect(doubts).toEqual([
      'the override "left-pad@v1.x" and "left-pad" "^1.2.0" of the project are ranges opm does not read as pnpm does, so whether it applies is not known',
    ]);
  });
});
