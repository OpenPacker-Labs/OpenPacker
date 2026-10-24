import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakeWeb,
  buildRelease,
  generateTestKey,
  githubWorld,
  type TestKey,
} from '@openpacker/packslip-testkit';
import {
  PackslipError,
  TrustChangeError,
  assertFingerprint,
  checkRequirements,
  decodeReleaseStatement,
  detectHost,
  parseProject,
  resolveRelease,
  type Artifact,
} from '../src/index.js';

/**
 * A signed statement, a release list, a certificate and a forge are the vendor's
 * to word, and what this package quotes of them reaches a terminal, a log and a
 * policy report. Whatever the vendor wrote (an escape sequence that retitles the
 * window, a line break and a line that looks like opm's, NEL, a right-to-left
 * override, a zero-width space), a refusal is plain text, and one line unless it
 * is a list whose entries this package wrote.
 */
/** Characters by code point, so no source line holds a separator or an override. */
const chars = (...codes: number[]): string => String.fromCodePoint(...codes);
const ESC = chars(0x1b);
const BEL = chars(0x07);
const HOSTILE = [
  'evil',
  `${ESC}]0;retitled${BEL}`,
  'name',
  '\r\n',
  'opm: ok installed 1 package',
  chars(0x85, 0x202e, 0x200b),
  'X',
  `${ESC}[2K`,
].join('');
/** What no message may hold: an escape, a C0/C1 control, a format or bidirectional character, a separator. */
const UNSAFE = new RegExp(
  `[${[
    [0x00, 0x09],
    [0x0b, 0x1f],
    [0x7f, 0x9f],
    [0x200b, 0x200f],
    [0x2028, 0x202e],
    [0x2060, 0x2069],
    [0xfeff, 0xfeff],
  ]
    .map(([from, to]) => `\\u{${from!.toString(16)}}-\\u{${to!.toString(16)}}`)
    .join('')}]`,
  'u',
);

function expectPlain(message: string, lines = 1): void {
  expect(message).not.toMatch(UNSAFE);
  expect(message.split('\n')).toHaveLength(lines);
  // The text the vendor added stays on the line it was quoted on.
  for (const line of message.split('\n')) expect(line).not.toMatch(/^opm: /u);
}

const PROJECT = 'github.com/acme/tool';
const host = detectHost({
  platform: 'linux',
  arch: 'x64',
  glibcVersion: '2.36',
  kernelRelease: '6.1.0',
  env: {},
  libraryDirectories: [],
});
let key: TestKey;
let web: FakeWeb;

beforeEach(() => {
  key = generateTestKey();
  web = new FakeWeb();
});

async function refusal(action: Promise<object | void> | (() => void)) {
  try {
    await (typeof action === 'function' ? action() : action);
  } catch (error) {
    if (error instanceof PackslipError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('a refusal of this package', () => {
  it('is one plain line whatever it quoted', () => {
    const error = new PackslipError('INVALID_INPUT', `bad ${HOSTILE} text`);
    expectPlain(error.message);
    expect(error.message).toContain('bad evil');
    expect(error.message).toContain('text');
  });

  it('lists its entries one to a line, each made plain', () => {
    const error = new PackslipError('HOST_INCOMPATIBLE', `head ${HOSTILE}`, [
      `first ${HOSTILE}`,
      'second',
    ]);
    expectPlain(error.message, 3);
    expect(error.message.split('\n').slice(1)).toEqual([
      expect.stringMatching(/^ {2}- first evil/u),
      '  - second',
    ]);
  });

  it('names the changes of a trust change one to a line', () => {
    const error = new TrustChangeError('prop_1', PROJECT, [
      `The signer changed: ${HOSTILE}`,
      'The scheme weakened',
    ]);
    expectPlain(error.message, 3);
    expect(error.changes).toHaveLength(2);
  });
});

describe('text the vendor chose, quoted at the source', () => {
  it('in a project name and a pinned fingerprint', () => {
    expectPlain(
      (() => {
        try {
          parseProject(HOSTILE);
        } catch (error) {
          return error instanceof Error ? error.message : '';
        }
        return '';
      })(),
    );
    expectPlain(
      (() => {
        try {
          assertFingerprint(HOSTILE);
        } catch (error) {
          return error instanceof Error ? error.message : '';
        }
        return '';
      })(),
    );
  });

  it('in the requirements of an artifact', () => {
    const artifact: Artifact = {
      name: 'tool.tar.gz',
      requires: {
        libs: [HOSTILE],
        bin: [{ name: HOSTILE, min: `1.${HOSTILE}` }],
      },
      // SAFETY: only the requirements are read.
    } as Artifact;
    const report = checkRequirements(artifact, {
      os: 'linux',
      hasLibrary: () => false,
      command: () => ({ found: true, version: HOSTILE }),
    });
    expect(report.refusals).toHaveLength(1);
    expect(report.warnings).toHaveLength(1);
    for (const line of [...report.refusals, ...report.warnings])
      expectPlain(line);
  });

  it('in a signed statement that lists a subject twice', async () => {
    const built = buildRelease({ project: PROJECT, version: '1.0.0', key });
    const statement = JSON.parse(JSON.stringify(built.statement));
    const subject = { ...statement.subject[0], name: HOSTILE };
    statement.subject = [subject, subject];
    const error = await refusal(() => decodeReleaseStatement(statement));
    expectPlain(error.message);
    expect(error.message).toContain('appears twice');
  });

  it('in an artifact name the host cannot run, through the real resolver', async () => {
    const built = buildRelease({
      project: PROJECT,
      version: '1.0.0',
      key,
      artifacts: [
        {
          os: 'linux',
          arch: 'x86_64',
          libc: 'gnu',
          name: `${HOSTILE}.tar.gz`,
          requires: { libs: [HOSTILE] },
        },
      ],
    });
    githubWorld(web, {
      repo: 'acme/tool',
      releases: [{ tag: 'v1.0.0', release: built }],
    });
    const error = await refusal(
      resolveRelease({
        project: parseProject(PROJECT),
        request: { spec: 'latest', prerelease: false },
        signer: { publicKey: key.publicKeyFile, allowUnlogged: true },
        fetcher: web,
        now: new Date('2026-10-11T00:00:00Z'),
        host,
        formats: ['tar.gz', 'zip'],
      }),
    );
    expect(error.code).toBe('HOST_INCOMPATIBLE');
    expectPlain(error.message, 2);
    expect(error.message).toContain('cannot run here');
  });
});
