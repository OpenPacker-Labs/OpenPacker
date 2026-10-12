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
    // A peer range is not overridden.
    expect([...out.peerDependencies]).toEqual([['a', '^1.0.0']]);
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
