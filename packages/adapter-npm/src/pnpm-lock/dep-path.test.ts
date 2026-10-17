import { describe, expect, it } from 'vitest';
import { formatDepPath, packageKeyOf, parseDepPath } from './dep-path.js';
import { PnpmLockError, type PnpmLockReason } from './errors.js';
import { DEFAULT_PNPM_LOCK_LIMITS, resolvePnpmLockLimits } from './limits.js';

const parse = (text: string, limits = DEFAULT_PNPM_LOCK_LIMITS) =>
  parseDepPath(text, limits, 'snapshots');

function reasonOf(text: string, limits = DEFAULT_PNPM_LOCK_LIMITS) {
  try {
    parse(text, limits);
  } catch (error) {
    if (error instanceof PnpmLockError) return error.reason as PnpmLockReason;
    throw error;
  }
  return 'parsed';
}

const SHA = '0123456789abcdef0123456789abcdef01234567';
const PATCH = 'wbmb7dwhiv66et2i6bbymnlkhi';

/** Every form a key or a value takes, from the four real locks and from pnpm's resolvers. */
const FORMS = [
  'react@18.2.0',
  '@scope/name@1.0.0',
  '@types/node@22.20.5',
  'a@1.0.0-beta.1',
  'a@1.0.0-rc.1+build.5',
  'a@1.2.3+20130313144700',
  'react-dom@18.2.0(react@18.2.0)',
  '@agentv/core@4.42.4(@modelcontextprotocol/sdk@1.30.0(@cfworker/json-schema@4.1.1)(zod@4.4.3))(ws@8.21.0)',
  '@stryker-mutator/vitest-runner@10.0.0(@stryker-mutator/core@10.0.0(@types/node@24.13.2))(vitest@4.1.9(@types/node@24.13.2)(@vitest/ui@4.1.9(vitest@4.1.9)))',
  `@simple-git/argv-parser@2.0.1(patch_hash=${PATCH})`,
  `a@1.0.0(patch_hash=${PATCH})(b@2.0.0(patch_hash=${PATCH})(c@3.0.0))`,
  'a@1.0.0(0f1e2d3c4b5a69788796a5b4c3d2e1f0)',
  `a@1.0.0(patch_hash=${PATCH})(0f1e2d3c4b5a69788796a5b4c3d2e1f0)`,
  'a@1.0.0(b@1.0.0(0f1e2d3c4b5a69788796a5b4c3d2e1f0))',
  'a@1.0.0-rc.1(react@18.0.0-rc.1)',
  'a@1.0.0(b@file:../b)',
  'a@1.0.0(b@git+https://github.com/u/b.git#' + SHA + ')',
  'a@file:../vendor/a',
  'a@file:packages/a.tgz',
  'a@file:../a(react@18.2.0)'.replace('(react@18.2.0)', ''),
  'a@https://codeload.github.com/user/repo/tar.gz/' + SHA,
  'a@https://codeload.github.com/user/repo/tar.gz/' + SHA + '#path:packages/a',
  'a@https://registry.example.com/a/-/a-1.0.0.tgz(react@18.2.0)',
  `a@git+https://github.com/user/repo.git#${SHA}`,
  `a@git+ssh://git@github.com/user/repo.git#${SHA}`,
  `a@git+ssh://deploy@git.example.com/user/repo.git#${SHA}&path:packages/a`,
  `a@git+https://git@github.com:user/repo.git#${SHA}`,
  `@s/a@git+https://github.com/user/repo.git#${SHA}&path:sub(b@1.0.0)`,
  'node@runtime:22.0.0',
  'node@runtime:22.0.0-rc.1',
] as const;

describe('parseDepPath', () => {
  it('splits name, version and peers', () => {
    expect(parse('react-dom@18.2.0(react@18.2.0)')).toEqual({
      raw: 'react-dom@18.2.0(react@18.2.0)',
      name: 'react-dom',
      version: '18.2.0',
      source: 'registry',
      peers: [
        {
          raw: 'react@18.2.0',
          name: 'react',
          version: '18.2.0',
          source: 'registry',
          peers: [],
        },
      ],
    });
  });

  it('reads a scoped name, whose first @ is not the separator', () => {
    const path = parse('@scope/name@1.0.0');
    expect([path.name, path.version]).toEqual(['@scope/name', '1.0.0']);
  });

  it('reads nested peers by their parentheses, not by guessing', () => {
    const path = parse(
      'a@1.0.0(b@2.0.0(c@3.0.0)(d@4.0.0))(e@5.0.0(f@6.0.0(g@7.0.0)))',
    );
    expect(path.peers.map((peer) => peer.raw)).toEqual([
      'b@2.0.0(c@3.0.0)(d@4.0.0)',
      'e@5.0.0(f@6.0.0(g@7.0.0))',
    ]);
    expect(path.peers[0]?.peers.map((peer) => peer.name)).toEqual(['c', 'd']);
    expect(path.peers[1]?.peers[0]?.peers[0]?.name).toBe('g');
  });

  it('reads a patch hash first, then the peers', () => {
    const path = parse(`a@1.0.0(patch_hash=${PATCH})(b@2.0.0)`);
    expect(path.patchHash).toBe(PATCH);
    expect(path.peers.map((peer) => peer.name)).toEqual(['b']);
    expect(path.version).toBe('1.0.0');
  });

  it('reads the hash that stands for peers too long to list', () => {
    const path = parse('a@1.0.0(0f1e2d3c4b5a69788796a5b4c3d2e1f0)');
    expect(path.peersHash).toBe('0f1e2d3c4b5a69788796a5b4c3d2e1f0');
    expect(path.peers).toEqual([]);
  });

  it('names the source each version form comes from', () => {
    const sources = [
      'a@1.0.0',
      'a@file:../a',
      'a@https://h.example/a.tgz',
      `a@git+https://h.example/a.git#${SHA}`,
      'node@runtime:22.0.0',
    ].map((text) => parse(text).source);
    expect(sources).toEqual(['registry', 'file', 'tarball', 'git', 'runtime']);
  });

  it('keeps a git address with its subdirectory, and an http URL with its fragment', () => {
    expect(
      parse(`a@git+ssh://git@github.com/u/r.git#${SHA}&path:p/q`).version,
    ).toBe(`git+ssh://git@github.com/u/r.git#${SHA}&path:p/q`);
    expect(parse('a@https://h.example/a.tgz#path:p').version).toBe(
      'https://h.example/a.tgz#path:p',
    );
  });

  it('reads the key of its package without the suffix', () => {
    expect(packageKeyOf(parse(`a@1.0.0(patch_hash=${PATCH})(b@2.0.0)`))).toBe(
      'a@1.0.0',
    );
    expect(packageKeyOf(parse('a@file:../a'))).toBe('a@file:../a');
  });

  it.each(FORMS)('round-trips %s', (text) => {
    expect(formatDepPath(parse(text))).toBe(text);
    expect(parse(text).raw).toBe(text);
  });
});

describe('parseDepPath: refusals', () => {
  it.each<[string, PnpmLockReason, string]>([
    ['react', 'dep-path', 'no version separator'],
    ['@scope/react', 'dep-path', 'scoped, no version'],
    ['react@', 'dep-path', 'empty version'],
    ['@1.0.0', 'dep-path', 'no name'],
    ['react@18.2.0(', 'dep-path', 'open paren at the end'],
    ['react@18.2.0)', 'dep-path', 'close paren at the end'],
    ['react@18.2.0(a@1.0.0', 'dep-path', 'unclosed group'],
    ['react@18.2.0a@1.0.0)', 'dep-path', 'unopened group'],
    ['react@18.2.0(a@1.0.0))', 'dep-path', 'one close too many'],
    ['react@18.2.0((a@1.0.0)', 'dep-path', 'one open too many'],
    ['react@18.2.0()', 'dep-path', 'empty group'],
    ['react@18.2.0(a@1.0.0)x', 'dep-path', 'text after the suffix'],
    ['react@18.2.0(a@1.0.0)x(b@1.0.0)', 'dep-path', 'text between groups'],
    ['a@file:../a(b)c', 'dep-path', 'paren inside a path'],
    [
      'react@18.2.0(foo)',
      'dep-path',
      'a group that is neither a peer nor a hash',
    ],
    [
      'react@18.2.0(0F1E2D3C4B5A69788796A5B4C3D2E1F0)',
      'dep-path',
      'upper case hash',
    ],
    ['react@18.2.0(0f1e2d3c)', 'dep-path', 'short hash'],
    [
      'a@1.0.0(0f1e2d3c4b5a69788796a5b4c3d2e1f0)(b@1.0.0)',
      'dep-path',
      'hash then peer',
    ],
    [
      'a@1.0.0(b@1.0.0)(0f1e2d3c4b5a69788796a5b4c3d2e1f0)',
      'dep-path',
      'peer then hash',
    ],
    [
      `a@1.0.0(b@1.0.0)(patch_hash=${PATCH})`,
      'dep-path',
      'patch hash not first',
    ],
    [
      `a@1.0.0(patch_hash=${PATCH})(patch_hash=${PATCH})`,
      'dep-path',
      'patch hash twice',
    ],
    ['a@1.0.0(patch_hash=)', 'dep-path', 'empty patch hash'],
    ['a@1.0.0(patch_hash=A-B)', 'dep-path', 'patch hash with a bad character'],
    ['../x@1.0.0', 'name', 'path as a name'],
    ['.bin@1.0.0', 'name', 'leading dot'],
    ['node_modules@1.0.0', 'name', 'node_modules'],
    ['a/b@1.0.0', 'name', 'slash in an unscoped name'],
    ['a@1.0.0(../x@1.0.0)', 'name', 'bad name in a peer'],
    ['a@latest', 'dep-path', 'a tag'],
    ['a@^1.0.0', 'dep-path', 'a range'],
    ['a@1.0', 'dep-path', 'two components'],
    ['a@01.0.0', 'dep-path', 'leading zero'],
    ['a@v1.0.0', 'dep-path', 'v prefix'],
    ['a@1.0.0 ', 'dep-path', 'trailing space'],
    ['a@file:', 'dep-path', 'empty file path'],
    ['a@file:/etc/passwd', 'dep-path', 'absolute file path'],
    ['a@file:C:/x', 'dep-path', 'drive file path'],
    ['a@file:..\\x', 'dep-path', 'backslash path'],
    ['a@file:../x\u0000y', 'dep-path', 'NUL in a path'],
    [
      'a@https://user:secret@host.example/a.tgz',
      'dep-path',
      'password in a tarball URL',
    ],
    ['a@https://token@host.example/a.tgz', 'dep-path', 'user in a tarball URL'],
    ['a@https:///a.tgz', 'dep-path', 'no host'],
    ['a@http://', 'dep-path', 'empty http URL'],
    [
      `a@git+https://TOKEN@github.com/u/r.git#${SHA}`,
      'dep-path',
      'token as the user of an https git address',
    ],
    [
      `a@git+ssh://git:pw@github.com/u/r.git#${SHA}`,
      'dep-path',
      'password in an ssh git address',
    ],
    ['a@git+https://github.com/u/r.git', 'dep-path', 'git without a commit'],
    ['a@git+https://github.com/u/r.git#main', 'dep-path', 'git with a branch'],
    [
      'a@git+https://github.com/u/r.git#abc1234',
      'dep-path',
      'git with a short commit',
    ],
    [`a@git+github.com/u/r.git#${SHA}`, 'dep-path', 'git without a scheme'],
    ['a@runtime:^22', 'dep-path', 'runtime range'],
    ['a@runtime:', 'dep-path', 'runtime with nothing'],
    ['a@npm:b@1.0.0', 'dep-path', 'npm: is a specifier, never a key'],
    ['a@link:../a', 'dep-path', 'link: is never a package'],
    ['a@workspace:*', 'dep-path', 'workspace: is a specifier, never a key'],
  ])('refuses %s (%s)', (text, reason) => {
    expect(reasonOf(text)).toBe(reason);
  });

  it('names a peer that a workspace sibling satisfies, and the sibling', () => {
    const message = (text: string): string => {
      try {
        parse(text);
      } catch (error) {
        return (error as PnpmLockError).message;
      }
      return '';
    };
    const shown = message('plug@1.0.0(ui@link:../ui)');
    expect(shown).toContain('"ui@link:../ui"');
    expect(shown).toContain(
      'the peer "ui" satisfied by the workspace member at "../ui"',
    );
    // The member is installed, as a link; what opm ci does not lay out is an
    // instance of the package keyed by it.
    expect(shown).toContain('keyed by a workspace member');
    expect(shown).not.toContain('does not place');
    // Not a peer, a package that is a link: the general message stays.
    expect(message('ui@link:../ui')).toContain('has a version that');
  });

  it('says which parenthesis is wrong', () => {
    const message = (text: string) => {
      try {
        parse(text);
      } catch (error) {
        return (error as PnpmLockError).message;
      }
      return '';
    };
    expect(message('react@18.2.0(a@1.0.0))')).toContain('never opened');
    expect(message('react@18.2.0((a@1.0.0)')).toContain('never closes');
    expect(message('react@(a@1.0.0)(b@1.0.0)')).toContain('has no version');
    expect(message('react@18.2.0(a@1.0.0')).toContain('not a peer suffix');
  });

  it('names the key and where it is', () => {
    try {
      parse('a@latest');
    } catch (error) {
      expect(error).toBeInstanceOf(PnpmLockError);
      expect((error as PnpmLockError).message).toContain('"a@latest"');
      expect((error as PnpmLockError).where).toBe('snapshots');
      return;
    }
    throw new Error('expected a refusal');
  });

  it('refuses nesting and groups past the limits, and a key past maxKeyLength', () => {
    const nested = (depth: number) =>
      `a@1.0.0${'(b@1.0.0'.repeat(depth)}${')'.repeat(depth)}`;
    const limits = resolvePnpmLockLimits({ maxPeerDepth: 4 });
    expect(reasonOf(nested(4), limits)).toBe('parsed');
    expect(reasonOf(nested(5), limits)).toBe('limit');
    const wide = resolvePnpmLockLimits({ maxPeerGroups: 3 });
    expect(reasonOf('a@1.0.0(b@1.0.0)(c@1.0.0)(d@1.0.0)', wide)).toBe('parsed');
    expect(reasonOf('a@1.0.0(b@1.0.0)(c@1.0.0)(d@1.0.0)(e@1.0.0)', wide)).toBe(
      'limit',
    );
    const short = resolvePnpmLockLimits({ maxKeyLength: 20 });
    expect(reasonOf('a@1.0.0(b@1.0.0)(c@1.0.0)', short)).toBe('limit');
  });

  it('stops at maxPeerDepth on a hundred thousand nested groups, and refuses them unbalanced', () => {
    const open = '(b@1.0.0'.repeat(100_000);
    const long = resolvePnpmLockLimits({ maxKeyLength: 10_000_000 });
    expect(() => parse(`a@1.0.0${open}${')'.repeat(100_000)}`, long)).toThrow(
      /maxPeerDepth/u,
    );
    expect(reasonOf(`a@1.0.0${open}`, long)).toBe('dep-path');
    expect(reasonOf(`a@1.0.0${open}`)).toBe('limit');
  });
});
