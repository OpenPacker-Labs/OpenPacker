import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpmError } from '@openpacker/opm-project';
import { formatFailure, parseFailure, report } from '../src/error-report.js';
import { EXIT_CODES, handleError, runOpm } from '../src/opm.js';
import { capture } from './capture.js';

/**
 * Some of what opm writes is a list: one entry to a line, the first line saying
 * what the entries are. The writer makes a message plain without flattening
 * it: a line feed the message carries stays, and nothing else that could move
 * a cursor, retitle a window or hide text does.
 */

const ESC = '\u001b';
const BEL = '\u0007';
/** Stands for a credential a lock holds in an address. */
const CANARY = 'vtok_dummy_marker_0123456789abcdef';

function written(error: unknown): { err: string; code: number } {
  const cap = capture();
  const code = handleError(error, cap.io);
  return { err: cap.err, code };
}

/** What `opm add` ends with when the walk could not lock a closure. */
const CLOSURE_REFUSAL =
  'Cannot lock the dependency closure of pkg:npm/needs-aix@1.0.0: UNSATISFIABLE: ' +
  '{"code":"UNSATISFIABLE","message":"no assignment satisfies all hard requirements","unsatCore":["root-0"]}\n' +
  'What the walk could not use:\n' +
  '  - pkg:npm/only-aix@1.0.0: does not run on this host (os=linux architecture=x64 libc=glibc)\n' +
  '  - pkg:npm/only-aix: no candidate satisfying 1.0.0 can be installed here';

describe('an error that is a list', () => {
  it('is written with its lines, as it was', () => {
    expect(written(new OpmError('UNRESOLVABLE', CLOSURE_REFUSAL))).toEqual({
      err: `opm: ${CLOSURE_REFUSAL}\n`,
      code: EXIT_CODES.unsatisfiable,
    });
  });

  it('keeps its indentation, blank lines and final line feed', () => {
    const message = 'one\n\n  - two\n    three\n';
    expect(written(new OpmError('NOT_FOUND', message)).err).toBe(
      `opm: ${message}\n`,
    );
  });

  it('loses what a terminal would act on, and keeps the lines around it', () => {
    const { err } = written(
      new OpmError(
        'UNRESOLVABLE',
        `refused:\n  - dep${ESC}[31m x${ESC}]0;pwned${BEL}\n  - ok‮\n`,
      ),
    );
    expect(err).toBe('opm: refused:\n  - dep x\n  - ok\n\n');
  });

  it('does not let a carriage return write over what came before it', () => {
    const { err } = written(
      new OpmError('UNRESOLVABLE', `real\rforged\r\n${ESC}[2Kmore`),
    );
    expect(err).toBe('opm: real\nforged\nmore\n');
  });

  it('is written with its lines when an error has no code of its own', () => {
    expect(written(new Error('first\n  second')).err).toBe(
      'opm: internal error: first\n  second\n',
    );
    const cap = formatFailure(parseFailure(new Error('first\n  second')), {
      tool: 'opmx',
      env: {},
    });
    expect(cap).toBe('opmx: first\n  second\n');
  });

  it('is withheld the same way: a credential on a later line is not shown', () => {
    expect(written(new Error('failed:\n  token=hunter2\n')).err).toBe(
      'opm: internal error: failed:\n  token=[REDACTED]\n\n',
    );
  });

  it('stays one line in a cause chain', () => {
    expect(
      written(new Error('outer', { cause: new Error('a\n  b') })).err,
    ).toBe('opm: internal error: outer\nopm:   caused by: Error: a b\n');
  });
});

describe('a message that is not a string', () => {
  it.each([
    ['undefined', undefined, 'opm: undefined\n'],
    ['null', null, 'opm: null\n'],
    ['a number', 42, 'opm: 42\n'],
  ])('is written as it was: %s', (_, message, expected) => {
    expect(report('opm: ', message)).toBe(expected);
  });

  it('does not stop the handler', () => {
    const error = Object.assign(new Error('x'), { code: 'OFFLINE' });
    // An error-like value from a library need not keep its message a string.
    Object.defineProperty(error, 'message', { value: undefined });
    expect(written(error)).toEqual({
      err: 'opm: undefined\n',
      code: EXIT_CODES.unavailable,
    });
  });
});

describe('the lists of opm ci, from a lock', () => {
  const temps: string[] = [];
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.OPM_STORE_HOME;
  });
  afterEach(async () => {
    if (previous === undefined) delete process.env.OPM_STORE_HOME;
    else process.env.OPM_STORE_HOME = previous;
    await Promise.all(
      temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  const registry = (name: string) => ({
    version: '1.0.0',
    resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
    integrity: `sha512-${createHash('sha512').update(name).digest('base64')}`,
  });
  const git = {
    version: '1.0.0',
    resolved:
      'git+https://example.test/b.git#0123456789abcdef0123456789abcdef01234567',
    integrity: registry('b').integrity,
  };

  async function ci(
    manifest: Record<string, unknown>,
    packages: Record<string, unknown>,
    options: string[] = [],
  ) {
    const dir = await mkdtemp(join(tmpdir(), 'opm-lines-'));
    const store = await mkdtemp(join(tmpdir(), 'opm-lines-store-'));
    temps.push(dir, store);
    process.env.OPM_STORE_HOME = join(store, 'shared');
    const root = { name: 'app', version: '1.0.0', ...manifest };
    await writeFile(join(dir, 'package.json'), JSON.stringify(root));
    await writeFile(
      join(dir, 'package-lock.json'),
      JSON.stringify({
        name: 'app',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: { '': root, ...packages },
      }),
    );
    const cap = capture();
    const code = await runOpm(['ci', '--path', dir, ...options], cap.io, '/');
    return { dir, err: cap.err, code };
  }

  it('lists the entries it cannot install, one to a line', async () => {
    const { dir, err, code } = await ci(
      { workspaces: ['packages/*'], dependencies: { a: '1.0.0' } },
      {
        'node_modules/a': registry('a'),
        'node_modules/member': { resolved: 'packages/member', link: true },
        'packages/member': { name: 'member', version: '1.0.0' },
      },
    );
    expect(code).toBe(EXIT_CODES.invalidInput);
    expect(err).toBe(
      `opm: Refusing to install ${join(dir, 'package-lock.json')}: it holds 2 entries opm ci cannot install, and installing the rest would not be installing the lock:\n` +
        '  node_modules/member: a link to packages/member; workspace members and links are not installed yet\n' +
        '  packages/member: a workspace member (member); workspaces are not installed yet\n',
    );
  });

  it('lists the packages the policy refuses, one to a line', async () => {
    const { err, code } = await ci(
      { dependencies: { a: '1.0.0' } },
      { 'node_modules/a': registry('a'), 'node_modules/b': git },
    );
    expect(code).toBe(EXIT_CODES.policyDenied);
    expect(err).toBe(
      'opm: Supply-chain policy refuses 1 package in the lock:\n' +
        '  node_modules/b (b@1.0.0): supply-chain.exotic-source: Exotic source kind "git" blocked at dependency depth 1\n',
    );
  });

  it('lists the packages from a git source, one to a line', async () => {
    const { err, code } = await ci(
      { dependencies: { a: '1.0.0', b: 'git+https://example.test/b.git' } },
      { 'node_modules/a': registry('a'), 'node_modules/b': git },
    );
    expect(code).toBe(EXIT_CODES.invalidInput);
    expect(err).toBe(
      'opm: opm ci installs from archives with a pinned digest, and cannot install 1 package from a git or path source yet:\n' +
        '  b@1.0.0 (node_modules/b): git+https://example.test/b.git\n',
    );
  });

  it('shows a git source with its scheme, host and path, and without its credentials', async () => {
    const { err } = await ci(
      {
        dependencies: {
          a: '1.0.0',
          b: 'git+https://example.test/b.git',
          c: 'git+ssh://git@github.com/o/c.git',
        },
      },
      {
        'node_modules/a': registry('a'),
        'node_modules/b': {
          ...git,
          resolved: `git+https://deploy:${CANARY}@example.test:8443/b.git?token=${CANARY}#0123456789abcdef`,
        },
        'node_modules/c': {
          ...git,
          resolved: 'git+ssh://git@github.com/o/c.git#0123456789abcdef',
        },
      },
    );
    expect(err).toBe(
      'opm: opm ci installs from archives with a pinned digest, and cannot install 2 packages from a git or path source yet:\n' +
        '  b@1.0.0 (node_modules/b): git+https://example.test:8443/b.git\n' +
        '  c@1.0.0 (node_modules/c): git+ssh://github.com/o/c.git\n',
    );
    expect(err).not.toContain(CANARY);
  });

  it('lists the packages missing from the store when it is offline, one to a line', async () => {
    const { err, code } = await ci(
      { dependencies: { a: '1.0.0', b: '1.0.0' } },
      { 'node_modules/a': registry('a'), 'node_modules/b': registry('b') },
      ['--offline'],
    );
    expect(code).toBe(EXIT_CODES.unavailable);
    expect(err).toBe(
      'opm: 2 packages are not in the local store and opm ci is offline:\n' +
        '  a@1.0.0 (node_modules/a)\n' +
        '  b@1.0.0 (node_modules/b)\n',
    );
  });
});
