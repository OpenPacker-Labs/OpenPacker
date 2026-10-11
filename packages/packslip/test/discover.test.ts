import { beforeEach, describe, expect, it } from 'vitest';
import {
  decodeReleaseList,
  discover,
  parseListPayload,
  parseProject,
  verifyBundle,
  type Discovery,
} from '../src/index.js';
import { generateTestKey, type TestKey } from '@openpacker/packslip-testkit';
import {
  FakeWeb,
  buildList,
  buildRelease,
  githubWorld,
  publish,
} from '@openpacker/packslip-testkit';

let key: TestKey;
let web: FakeWeb;
const NOW = new Date('2026-10-01T00:00:00Z');
const project = parseProject('github.com/acme/tool');

const verifyList = (signer: TestKey) => (bundle: Uint8Array) =>
  decodeReleaseList(
    parseListPayload(
      verifyBundle({
        bundle,
        expectation: {
          scheme: 'sigstore-key',
          publicKey: signer.publicKeyFile,
        },
        allowUnlogged: true,
      }).payload,
    ),
  );

const release = (version: string, signer = key) =>
  buildRelease({ project: 'github.com/acme/tool', version, key: signer });

function run(
  over: Partial<Parameters<typeof discover>[0]> = {},
): Promise<Discovery> {
  return discover({
    project,
    fetcher: web,
    now: NOW,
    verifyList: verifyList(key),
    ...over,
  });
}

beforeEach(() => {
  key = generateTestKey();
  web = new FakeWeb();
});

describe('discovering a GitHub project’s releases', () => {
  it('derives versions from tags, skips drafts and releases without this project’s bundle', async () => {
    githubWorld(web, {
      repo: 'acme/tool',
      releases: [
        { tag: 'v1.2.0' },
        { tag: 'v1.1.0', draft: true },
        { tag: 'v1.0.0', assets: ['tool.tar.gz'] },
        { tag: 'nightly' },
        { tag: 'release-1.0.0' },
        { tag: 'tool-0.9.0' },
        { tag: '0.8.0' },
      ],
    });
    const found = await run();
    expect(found.candidates.map((c) => [c.version, c.tag]).sort()).toEqual([
      ['0.8.0', '0.8.0'],
      ['0.9.0', 'tool-0.9.0'],
      ['1.2.0', 'v1.2.0'],
    ]);
    expect(found.candidates[0]?.bundleUrl).toBe(
      'https://github.com/acme/tool/releases/download/v1.2.0/packslip.sigstore.json',
    );
    expect(found.list).toBeUndefined();
    expect(found.signedLatest).toBeUndefined();
  });

  it('percent-encodes a tag in the URL it builds', async () => {
    githubWorld(web, { repo: 'acme/tool', releases: [{ tag: 'tool/v1.0.0' }] });
    expect((await run()).candidates[0]?.bundleUrl).toBe(
      'https://github.com/acme/tool/releases/download/tool%2Fv1.0.0/packslip.sigstore.json',
    );
  });

  it('keeps one candidate when two tags spell the same version', async () => {
    githubWorld(web, {
      repo: 'acme/tool',
      releases: [{ tag: 'v1.0.0' }, { tag: '1.0.0' }],
    });
    expect((await run()).candidates).toHaveLength(1);
  });

  it('reports GitHub’s latest pointer as a version, and none when there is no latest', async () => {
    githubWorld(web, {
      repo: 'acme/tool',
      releases: [{ tag: 'v1.0.0' }, { tag: 'v2.0.0' }],
      latestTag: 'v1.0.0',
    });
    expect((await run()).githubLatest).toBe('1.0.0');
    web = new FakeWeb();
    githubWorld(web, { repo: 'acme/tool', releases: [{ tag: 'v1.0.0' }] });
    expect((await run()).githubLatest).toBeUndefined();
  });

  it('fails when the repository has no releases, and when GitHub errors', async () => {
    await expect(run()).rejects.toMatchObject({ code: 'NO_RELEASE' });
    web.set(
      'https://api.github.com/repos/acme/tool/releases?per_page=100&page=1',
      'rate limited',
      403,
    );
    await expect(run()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('refuses a releases listing that is not a list', async () => {
    web.setJson(
      'https://api.github.com/repos/acme/tool/releases?per_page=100&page=1',
      { not: 'a list' },
    );
    await expect(run()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    web.set(
      'https://api.github.com/repos/acme/tool/releases?per_page=100&page=1',
      'not json',
    );
    await expect(run()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('follows a second page only when the first is full', async () => {
    const page = (start: number) =>
      Array.from({ length: 100 }, (_, index) => ({
        tag_name: `v1.${start + index}.0`,
        draft: false,
        prerelease: false,
        assets: [{ name: 'packslip.sigstore.json' }],
      }));
    web.setJson(
      'https://api.github.com/repos/acme/tool/releases?per_page=100&page=1',
      page(0),
    );
    web.setJson(
      'https://api.github.com/repos/acme/tool/releases?per_page=100&page=2',
      page(100),
    );
    web.setJson(
      'https://api.github.com/repos/acme/tool/releases?per_page=100&page=3',
      [],
    );
    web.setMissing('https://api.github.com/repos/acme/tool/releases/latest');
    web.setMissing(
      'https://raw.githubusercontent.com/acme/tool/HEAD/.well-known/packslip.json',
    );
    expect((await run()).candidates).toHaveLength(200);
    expect(
      web.requests.filter((url) => url.includes('/releases?')),
    ).toHaveLength(3);
  });

  it('refuses a project hosted on GitLab, which has no defined discovery endpoint', async () => {
    await expect(
      run({ project: parseProject('gitlab.com/group/tool') }),
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      message: expect.stringContaining('GitLab'),
    });
  });
});

describe('a signed list laid over GitHub’s endpoint', () => {
  const v1 = () => release('1.0.0');
  const v2 = () => release('2.0.0');

  function setup(
    list: Uint8Array | undefined,
    tags = ['v1.0.0', 'v2.0.0'],
  ): void {
    githubWorld(web, {
      repo: 'acme/tool',
      releases: tags.map((tag) => ({ tag })),
      latestTag: 'v2.0.0',
      ...(list && { list }),
    });
  }

  it('applies a withdrawal, a security flag and a recommendation to listed versions', async () => {
    const a = v1();
    const b = v2();
    setup(
      buildList({
        project: 'github.com/acme/tool',
        key,
        sequence: 3,
        latest: '1.0.0',
        entries: [
          {
            version: '1.0.0',
            tag: 'v1.0.0',
            url: 'https://github.com/acme/tool/releases/download/v1.0.0/packslip.sigstore.json',
            release: a,
            security: true,
          },
          {
            version: '2.0.0',
            tag: 'v2.0.0',
            url: 'https://github.com/acme/tool/releases/download/v2.0.0/packslip.sigstore.json',
            release: b,
            yanked: 'bad build',
          },
        ],
      }),
    );
    const found = await run();
    const byVersion = new Map(
      found.candidates.map((candidate) => [candidate.version, candidate]),
    );
    expect(byVersion.get('2.0.0')).toMatchObject({
      yanked: true,
      yankReason: 'bad build',
    });
    expect(byVersion.get('1.0.0')).toMatchObject({
      yanked: false,
      security: true,
      bundleSha256: a.bundleSha256,
    });
    expect(found.signedLatest).toBe('1.0.0');
    expect(found.githubLatest).toBe('2.0.0');
    expect(found.list).toEqual({
      sequence: 3,
      expiresAt: '2027-09-01T00:00:00Z',
    });
  });

  it('leaves versions the list omits discoverable through the endpoint', async () => {
    const a = v1();
    setup(
      buildList({
        project: 'github.com/acme/tool',
        key,
        sequence: 1,
        entries: [
          {
            version: '1.0.0',
            url: 'https://github.com/acme/tool/releases/download/v1.0.0/packslip.sigstore.json',
            release: a,
          },
        ],
      }),
    );
    const found = await run();
    const byVersion = new Map(
      found.candidates.map((candidate) => [candidate.version, candidate]),
    );
    expect(byVersion.get('2.0.0')?.bundleSha256).toBeUndefined();
    expect(byVersion.get('1.0.0')?.bundleSha256).toBe(a.bundleSha256);
  });

  it('exposes a release whose tag names no version, by mapping it', async () => {
    const a = release('3.0.0');
    setup(
      buildList({
        project: 'github.com/acme/tool',
        key,
        sequence: 1,
        entries: [
          {
            version: '3.0.0',
            tag: 'nightly',
            url: 'https://github.com/acme/tool/releases/download/nightly/packslip.sigstore.json',
            release: a,
          },
        ],
      }),
      ['nightly'],
    );
    const found = await run();
    expect(found.candidates).toHaveLength(1);
    expect(found.candidates[0]).toMatchObject({
      version: '3.0.0',
      tag: 'nightly',
    });
  });

  it('refuses an expired list', async () => {
    setup(
      buildList({
        project: 'github.com/acme/tool',
        key,
        sequence: 1,
        expiresAt: '2026-09-30T00:00:00Z',
        entries: [],
      }),
    );
    await expect(run()).rejects.toMatchObject({ code: 'LIST_EXPIRED' });
  });

  it('refuses a list older than one already accepted, and accepts the same one again', async () => {
    setup(
      buildList({
        project: 'github.com/acme/tool',
        key,
        sequence: 4,
        entries: [],
      }),
    );
    await expect(
      run({ memory: { sequence: 5, used: true } }),
    ).rejects.toMatchObject({ code: 'LIST_ROLLBACK' });
    await expect(
      run({ memory: { sequence: 4, used: true } }),
    ).resolves.toMatchObject({ list: { sequence: 4 } });
  });

  it('refuses to fall back to the endpoint alone once a list was accepted', async () => {
    setup(undefined);
    await expect(run({ memory: { used: true } })).rejects.toMatchObject({
      code: 'LIST_MISSING',
    });
    await expect(run({ memory: { used: false } })).resolves.toBeDefined();
  });

  it('refuses a list for a different project', async () => {
    setup(
      buildList({
        project: 'github.com/acme/other',
        key,
        sequence: 1,
        entries: [],
      }),
    );
    await expect(run()).rejects.toMatchObject({ code: 'PROJECT_MISMATCH' });
  });

  it('refuses a list signed by someone else', async () => {
    setup(
      buildList({
        project: 'github.com/acme/tool',
        key: generateTestKey(),
        sequence: 1,
        entries: [],
      }),
    );
    await expect(run()).rejects.toMatchObject({ code: 'SIGNER_MISMATCH' });
  });

  it('refuses a list whose bytes were altered after signing', async () => {
    const good = buildList({
      project: 'github.com/acme/tool',
      key,
      sequence: 1,
      entries: [],
    });
    const parsed = JSON.parse(Buffer.from(good).toString('utf8'));
    parsed.dsseEnvelope.payload = Buffer.from(
      Buffer.from(parsed.dsseEnvelope.payload, 'base64')
        .toString()
        .replace('"sequence":1', '"sequence":0'),
    ).toString('base64');
    setup(Buffer.from(JSON.stringify(parsed)));
    await expect(run()).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });
  });
});

describe('a project on its own domain', () => {
  const own = parseProject('example.com/tools/demo');
  const listUrl = 'https://example.com/.well-known/packslip/tools/demo.json';

  it('is read entirely from its signed list', async () => {
    const a = buildRelease({
      project: 'example.com/tools/demo',
      version: '1.0.0',
      key,
    });
    const b = buildRelease({
      project: 'example.com/tools/demo',
      version: '1.1.0',
      key,
    });
    web.set(
      listUrl,
      buildList({
        project: 'example.com/tools/demo',
        key,
        sequence: 1,
        latest: '1.1.0',
        entries: [
          {
            version: '1.0.0',
            url: 'https://dl.example.com/1.0.0/packslip.sigstore.json',
            release: a,
          },
          {
            version: '1.1.0',
            url: 'https://dl.example.com/1.1.0/packslip.sigstore.json',
            release: b,
            yanked: true,
          },
        ],
      }),
    );
    const found = await run({ project: own });
    expect(
      found.candidates.map((c) => [c.version, c.yanked, c.bundleUrl]),
    ).toEqual([
      ['1.0.0', false, 'https://dl.example.com/1.0.0/packslip.sigstore.json'],
      ['1.1.0', true, 'https://dl.example.com/1.1.0/packslip.sigstore.json'],
    ]);
    expect(found.candidates[0]?.bundleSha256).toBe(a.bundleSha256);
    expect(found.signedLatest).toBe('1.1.0');
  });

  it('is refused, not guessed at, when it publishes no list', async () => {
    await expect(run({ project: own })).rejects.toMatchObject({
      code: 'NO_RELEASE',
      message: expect.stringContaining('will not guess'),
    });
  });

  it('fails on a server error and refuses an expired list', async () => {
    web.set(listUrl, 'oops', 500);
    await expect(run({ project: own })).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    web.set(
      listUrl,
      buildList({
        project: 'example.com/tools/demo',
        key,
        sequence: 1,
        expiresAt: '2026-01-01T00:00:00Z',
        entries: [],
      }),
    );
    await expect(run({ project: own })).rejects.toMatchObject({
      code: 'LIST_EXPIRED',
    });
  });
});

it('publishes a built release where a consumer would find it', () => {
  const built = release('1.0.0');
  publish(web, built, 'https://example.com/b.json');
  expect(web.requests).toEqual([]);
});
