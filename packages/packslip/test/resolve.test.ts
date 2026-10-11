import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  TrustChangeError,
  detectHost,
  parseProject,
  resolveRelease,
  type ResolveInput,
  type ResolvedRelease,
  type TrustMemory,
} from '../src/index.js';
import { generateTestKey, type TestKey } from '@openpacker/packslip-testkit';
import {
  FakeWeb,
  buildList,
  buildRelease,
  githubWorld,
  publish,
  type BuildOptions,
} from '@openpacker/packslip-testkit';

const NOW = new Date('2026-10-11T00:00:00Z');
const host = detectHost({
  platform: 'linux',
  arch: 'x64',
  glibcVersion: '2.36',
  kernelRelease: '6.1.0',
  env: {},
});

let key: TestKey;
let web: FakeWeb;

const PROJECT = 'github.com/acme/tool';
const bundleUrl = (tag: string) =>
  `https://github.com/acme/tool/releases/download/${tag}/packslip.sigstore.json`;

function build(version: string, over: Partial<BuildOptions> = {}) {
  return buildRelease({
    project: PROJECT,
    version,
    key,
    baseUrl: `https://github.com/acme/tool/releases/download/v${version}`,
    ...over,
  });
}

function input(over: Partial<ResolveInput> = {}): ResolveInput {
  return {
    project: parseProject(PROJECT),
    request: { spec: 'latest', prerelease: false },
    signer: { publicKey: key.publicKeyFile, allowUnlogged: true },
    fetcher: web,
    now: NOW,
    host,
    formats: ['tar.gz', 'zip'],
    ...over,
  };
}

function publishAll(
  versions: string[],
  list?: Uint8Array,
  latestTag?: string,
): ReturnType<typeof build>[] {
  const built = versions.map((version) => build(version));
  githubWorld(web, {
    repo: 'acme/tool',
    releases: built.map((release, index) => ({
      tag: `v${versions[index]}`,
      release,
    })),
    ...(latestTag !== undefined && { latestTag }),
    ...(list !== undefined && { list }),
  });
  return built;
}

async function refusal(action: Promise<unknown>) {
  try {
    await action;
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  key = generateTestKey();
  web = new FakeWeb();
});

describe('resolving a request to one verified release', () => {
  it('picks the highest version, verifies it, and selects the artifact for this host', async () => {
    publishAll(['1.0.0', '1.10.0', '1.9.0']);
    const resolved = await resolveRelease(input());
    expect(resolved.statement.version).toBe('1.10.0');
    expect(resolved.artifact.name).toContain('tool-1.10.0-linux-x86_64');
    expect(resolved.verified.logged).toBe(false);
    expect(resolved.verified.signer).toMatchObject({
      scheme: 'sigstore-key',
      identity: key.keyId,
    });
    expect(resolved.memory).toMatchObject({
      project: PROJECT,
      attestedBy: 'vendor',
      logged: false,
      signer: {
        scheme: 'sigstore-key',
        identity: key.keyId,
        pinWorkflow: true,
      },
    });
  });

  it('honours a version prefix, an exact version, and the vendor’s tag', async () => {
    publishAll(['1.0.0', '1.2.3', '1.2.9', '2.0.0']);
    expect(
      (
        await resolveRelease(
          input({ request: { spec: '1.2', prerelease: false } }),
        )
      ).statement.version,
    ).toBe('1.2.9');
    expect(
      (
        await resolveRelease(
          input({ request: { spec: '1.0.0', prerelease: false } }),
        )
      ).statement.version,
    ).toBe('1.0.0');
    expect(
      (
        await resolveRelease(
          input({ request: { spec: 'v1.2.3', prerelease: false } }),
        )
      ).statement.version,
    ).toBe('1.2.3');
    await expect(
      resolveRelease(input({ request: { spec: '9', prerelease: false } })),
    ).rejects.toMatchObject({
      code: 'NO_RELEASE',
    });
  });

  it('skips a prerelease for latest and takes it when asked for explicitly', async () => {
    publishAll(['1.0.0', '2.0.0-rc.1']);
    expect((await resolveRelease(input())).statement.version).toBe('1.0.0');
    expect(
      (
        await resolveRelease(
          input({ request: { spec: 'latest', prerelease: true } }),
        )
      ).statement.version,
    ).toBe('2.0.0-rc.1');
    expect(
      (
        await resolveRelease(
          input({
            request: { spec: 'latest', prerelease: false, channel: 'rc' },
          }),
        )
      ).statement.version,
    ).toBe('2.0.0-rc.1');
  });

  it('returns the resources that apply to the selected artifact', async () => {
    const release = build('1.0.0', {
      resources: [
        { kind: 'man', archive: 'tool/share/man/man1/tool.1' },
        { kind: 'completion', shell: 'zsh', archive: 'tool/share/zsh/_tool' },
      ],
      artifacts: [
        {
          os: 'linux',
          arch: 'x86_64',
          libc: 'gnu',
          files: [
            {
              path: 'tool/bin/tool',
              contents: '#!/bin/sh\n',
              executable: true,
            },
            { path: 'tool/share/man/man1/tool.1', contents: '.TH TOOL 1' },
            { path: 'tool/share/zsh/_tool', contents: '#compdef tool' },
          ],
        },
      ],
    });
    githubWorld(web, {
      repo: 'acme/tool',
      releases: [{ tag: 'v1.0.0', release }],
    });
    const resolved = await resolveRelease(input());
    expect(resolved.resources.map((group) => group.kind).sort()).toEqual([
      'completion',
      'man',
    ]);
    expect(
      resolved.resources.flatMap((group) =>
        group.alternatives.map((entry) => entry.source.kind),
      ),
    ).toEqual(['archive', 'archive']);
  });
});

describe('the vendor’s signed list changes what is offered', () => {
  const url = (tag: string) => bundleUrl(tag);

  it('never offers a withdrawn release, and says why it skipped the recommendation', async () => {
    const [a, b] = publishAll(['1.0.0', '2.0.0']);
    web.set(
      'https://raw.githubusercontent.com/acme/tool/HEAD/.well-known/packslip.json',
      buildList({
        project: PROJECT,
        key,
        sequence: 1,
        latest: '2.0.0',
        entries: [
          { version: '1.0.0', tag: 'v1.0.0', url: url('v1.0.0'), release: a! },
          {
            version: '2.0.0',
            tag: 'v2.0.0',
            url: url('v2.0.0'),
            release: b!,
            yanked: 'CVE-2026-1',
          },
        ],
      }),
    );
    const resolved = await resolveRelease(input());
    expect(resolved.statement.version).toBe('1.0.0');
    expect(resolved.notes.join('\n')).toContain(
      'Skipped the vendor-recommended 2.0.0: it was withdrawn (CVE-2026-1)',
    );
    expect(resolved.list).toMatchObject({ sequence: 1 });
    await expect(
      resolveRelease(input({ request: { spec: '2.0.0', prerelease: false } })),
    ).rejects.toMatchObject({ code: 'NO_RELEASE' });
  });

  it('puts the vendor’s recommendation first without hiding a newer release', async () => {
    const [a, b] = publishAll(['1.0.0', '2.0.0']);
    web.set(
      'https://raw.githubusercontent.com/acme/tool/HEAD/.well-known/packslip.json',
      buildList({
        project: PROJECT,
        key,
        sequence: 1,
        latest: '1.0.0',
        entries: [
          { version: '1.0.0', tag: 'v1.0.0', url: url('v1.0.0'), release: a! },
          { version: '2.0.0', tag: 'v2.0.0', url: url('v2.0.0'), release: b! },
        ],
      }),
    );
    expect((await resolveRelease(input())).statement.version).toBe('1.0.0');
    expect(
      (
        await resolveRelease(
          input({ request: { spec: '2', prerelease: false } }),
        )
      ).statement.version,
    ).toBe('2.0.0');
  });

  it('uses GitHub’s latest pointer only when no signed pointer exists', async () => {
    publishAll(['1.0.0', '2.0.0'], undefined, 'v1.0.0');
    expect((await resolveRelease(input())).statement.version).toBe('1.0.0');
  });

  it('falls straight to semver order when the signed pointer is ineligible, never to GitHub’s pointer', async () => {
    const [a, b] = publishAll(['1.0.0', '2.0.0', '3.0.0'], undefined, 'v1.0.0');
    const c = build('3.0.0');
    web.set(
      'https://raw.githubusercontent.com/acme/tool/HEAD/.well-known/packslip.json',
      buildList({
        project: PROJECT,
        key,
        sequence: 1,
        latest: '2.0.0',
        entries: [
          { version: '1.0.0', url: url('v1.0.0'), release: a! },
          { version: '2.0.0', url: url('v2.0.0'), release: b!, yanked: true },
          { version: '3.0.0', url: url('v3.0.0'), release: c },
        ],
      }),
    );
    // GitHub's pointer says 1.0.0; the signed pointer (2.0.0) was withdrawn.
    expect((await resolveRelease(input())).statement.version).toBe('3.0.0');
  });

  it('refuses a bundle whose digest is not the one the list pins', async () => {
    const [a] = publishAll(['1.0.0']);
    web.set(
      'https://raw.githubusercontent.com/acme/tool/HEAD/.well-known/packslip.json',
      buildList({
        project: PROJECT,
        key,
        sequence: 1,
        entries: [
          {
            version: '1.0.0',
            url: url('v1.0.0'),
            release: a!,
            pinnedSha256: 'f'.repeat(64),
          },
        ],
      }),
    );
    await expect(resolveRelease(input())).rejects.toMatchObject({
      code: 'DIGEST_MISMATCH',
    });
  });
});

describe('what a hostile or broken release must not be able to do', () => {
  it('does not fall back to an older release when the newest one is forged', async () => {
    const older = build('1.0.0');
    const forged = buildRelease({
      project: PROJECT,
      version: '2.0.0',
      key: generateTestKey(),
      baseUrl: 'https://github.com/acme/tool/releases/download/v2.0.0',
    });
    githubWorld(web, {
      repo: 'acme/tool',
      releases: [
        { tag: 'v2.0.0', release: forged },
        { tag: 'v1.0.0', release: older },
      ],
    });
    await expect(resolveRelease(input())).rejects.toMatchObject({
      code: 'SIGNER_MISMATCH',
    });
    expect(web.requests).not.toContain(bundleUrl('v1.0.0'));
  });

  it('does not fall back when the newest bundle cannot be fetched', async () => {
    const older = build('1.0.0');
    githubWorld(web, {
      repo: 'acme/tool',
      releases: [{ tag: 'v2.0.0' }, { tag: 'v1.0.0', release: older }],
    });
    web.set(bundleUrl('v2.0.0'), 'overloaded', 503);
    await expect(resolveRelease(input())).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    expect(web.requests).not.toContain(bundleUrl('v1.0.0'));
  });

  it('refuses a release whose signed version differs from the one its tag names', async () => {
    const liar = build('9.9.9');
    githubWorld(web, {
      repo: 'acme/tool',
      releases: [{ tag: 'v1.0.0', release: liar }],
    });
    await expect(resolveRelease(input())).rejects.toMatchObject({
      code: 'PROJECT_MISMATCH',
      message: expect.stringContaining(
        'names version 1.0.0, but the signed release is 9.9.9',
      ),
    });
  });

  it('refuses a release signed for a different project than the one requested', async () => {
    const other = buildRelease({
      project: 'github.com/evil/tool',
      version: '1.0.0',
      key,
    });
    githubWorld(web, {
      repo: 'acme/tool',
      releases: [{ tag: 'v1.0.0', release: other }],
    });
    await expect(resolveRelease(input())).rejects.toMatchObject({
      code: 'PROJECT_MISMATCH',
      message: expect.stringContaining('github.com/evil/tool'),
    });
  });

  it('refuses a document that claims a signer other than the one that signed it', async () => {
    const lying = build('1.0.0', { identity: { key_id: 'DEADBEEFDEADBEEF' } });
    githubWorld(web, {
      repo: 'acme/tool',
      releases: [{ tag: 'v1.0.0', release: lying }],
    });
    await expect(resolveRelease(input())).rejects.toMatchObject({
      code: 'SIGNER_MISMATCH',
      message: expect.stringContaining('DEADBEEFDEADBEEF'),
    });
  });

  it('refuses a document that claims a different signature scheme', async () => {
    const lying = build('1.0.0', {
      identity: { scheme: 'sigstore-oidc', key_id: key.keyId },
    });
    githubWorld(web, {
      repo: 'acme/tool',
      releases: [{ tag: 'v1.0.0', release: lying }],
    });
    await expect(resolveRelease(input())).rejects.toMatchObject({
      code: 'SIGNER_MISMATCH',
    });
  });

  it('refuses an unlogged key-signed release unless that was allowed', async () => {
    publishAll(['1.0.0']);
    await expect(
      resolveRelease(input({ signer: { publicKey: key.publicKeyFile } })),
    ).rejects.toMatchObject({ code: 'UNLOGGED' });
  });

  it('refuses a release of a project with no signer configured, when its name cannot say who signs', async () => {
    await expect(
      resolveRelease(
        input({ project: parseProject('example.com/tools/demo'), signer: {} }),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('own domain'),
    });
    await expect(
      resolveRelease(
        input({
          project: parseProject('example.com/tools/demo'),
          signer: { issuer: 'https://issuer.example' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('serves nothing when there is nothing signed to find', async () => {
    githubWorld(web, { repo: 'acme/tool', releases: [] });
    await expect(resolveRelease(input())).rejects.toMatchObject({
      code: 'NO_RELEASE',
    });
  });
});

describe('signer continuity across installs', () => {
  const remembered = (): TrustMemory => ({
    project: PROJECT,
    signer: { scheme: 'sigstore-key', identity: key.keyId, pinWorkflow: true },
    attestedBy: 'vendor',
    logged: false,
    provenance: false,
  });

  it('accepts the same signer again', async () => {
    publishAll(['1.0.0']);
    expect(await resolveRelease(input({ memory: remembered() }))).toMatchObject(
      { approvedChanges: [] },
    );
  });

  it('refuses a new key until a person approves exactly that change', async () => {
    const rotated = generateTestKey();
    const previous: TrustMemory = {
      ...remembered(),
      signer: {
        scheme: 'sigstore-key',
        identity: rotated.keyId,
        pinWorkflow: true,
      },
    };
    publishAll(['1.0.0']);
    const error = await refusal(resolveRelease(input({ memory: previous })));
    expect(error).toBeInstanceOf(TrustChangeError);
    const proposal = error as TrustChangeError;
    expect(proposal.changes[0]).toContain('key');
    expect(proposal.message).toContain(proposal.proposalId);

    await expect(
      resolveRelease(
        input({ memory: previous, approvals: ['0000000000000000'] }),
      ),
    ).rejects.toBeInstanceOf(TrustChangeError);
    const approved = await resolveRelease(
      input({ memory: previous, approvals: [proposal.proposalId] }),
    );
    expect(approved.approvedChanges).toHaveLength(1);
    expect(approved.memory.signer.identity).toBe(key.keyId);
  });
});

describe('minimum release age', () => {
  it('skips a release younger than the minimum and takes the next', async () => {
    publishAll(['1.0.0', '2.0.0']);
    // Unlogged bundles are aged from published_at, which the builder fixes at 2026-09-01.
    const day = 24 * 3600 * 1000;
    const resolved = await resolveRelease(
      input({
        now: new Date('2026-09-01T12:00:00Z'),
        minimumReleaseAgeMs: 100 * day,
      }),
    ).catch((error: unknown) => error);
    expect(resolved).toMatchObject({
      code: 'NO_RELEASE',
      message: expect.stringContaining('2.0.0, 1.0.0'),
    });
    const older = await resolveRelease(
      input({ now: NOW, minimumReleaseAgeMs: 30 * day }),
    );
    expect(older.statement.version).toBe('2.0.0');
  });

  it('measures the age of each candidate on its own', async () => {
    const young = build('2.0.0', { publishedAt: '2026-10-10T00:00:00Z' });
    const old = build('1.0.0', { publishedAt: '2026-08-01T00:00:00Z' });
    githubWorld(web, {
      repo: 'acme/tool',
      releases: [
        { tag: 'v2.0.0', release: young },
        { tag: 'v1.0.0', release: old },
      ],
    });
    const resolved = await resolveRelease(
      input({ minimumReleaseAgeMs: 7 * 24 * 3600 * 1000 }),
    );
    expect(resolved.statement.version).toBe('1.0.0');
  });
});

describe('choosing an artifact and checking the host', () => {
  it('reports no artifact for a host nothing was built for', async () => {
    publishAll(['1.0.0']);
    await expect(
      resolveRelease(
        input({
          host: detectHost({
            platform: 'darwin',
            arch: 'arm64',
            kernelRelease: '24',
            env: {},
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'NO_ARTIFACT' });
  });

  it('selects a variant only when asked for it', async () => {
    const release = build('1.0.0', {
      artifacts: [
        { os: 'linux', arch: 'x86_64', libc: 'gnu' },
        { os: 'linux', arch: 'x86_64', libc: 'gnu', variant: 'fips' },
      ],
    });
    githubWorld(web, {
      repo: 'acme/tool',
      releases: [{ tag: 'v1.0.0', release }],
    });
    expect((await resolveRelease(input())).artifact.variant).toBeUndefined();
    expect(
      (await resolveRelease(input({ variant: 'fips' }))).artifact.variant,
    ).toBe('fips');
  });

  it('uses a musl build on a glibc host only when that fallback is enabled, and says so', async () => {
    const release = build('1.0.0', {
      artifacts: [{ os: 'linux', arch: 'x86_64', libc: 'musl' }],
    });
    githubWorld(web, {
      repo: 'acme/tool',
      releases: [{ tag: 'v1.0.0', release }],
    });
    await expect(resolveRelease(input())).rejects.toMatchObject({
      code: 'NO_ARTIFACT',
    });
    const resolved = await resolveRelease(
      input({ fallbacks: ['musl-on-gnu'] }),
    );
    expect(resolved.fallback).toBe('musl-on-gnu');
    expect(resolved.notes.join('\n')).toContain('musl-on-gnu');
  });

  it('refuses an artifact the host cannot run, unless told to install anyway', async () => {
    const release = build('1.0.0', {
      artifacts: [
        {
          os: 'linux',
          arch: 'x86_64',
          libc: 'gnu',
          requires: { glibc_min: '2.39', libs: [] },
        },
      ],
    });
    githubWorld(web, {
      repo: 'acme/tool',
      releases: [{ tag: 'v1.0.0', release }],
    });
    await expect(resolveRelease(input())).rejects.toMatchObject({
      code: 'HOST_INCOMPATIBLE',
      message: expect.stringContaining('glibc 2.39'),
    });
    const resolved = await resolveRelease(
      input({ allowIncompatibleHost: true }),
    );
    expect(resolved.requirements.refusals).toHaveLength(1);
  });

  it('surfaces a missing optional command as a warning, not a failure', async () => {
    const release = build('1.0.0', {
      artifacts: [
        {
          os: 'linux',
          arch: 'x86_64',
          libc: 'gnu',
          requires: { bin: [{ name: 'java', min: '17' }] },
        },
      ],
    });
    githubWorld(web, {
      repo: 'acme/tool',
      releases: [{ tag: 'v1.0.0', release }],
    });
    const resolved = await resolveRelease(input());
    expect(resolved.requirements.refusals).toEqual([]);
    expect(resolved.requirements.warnings[0]).toContain('java');
  });
});

describe('a project on its own domain', () => {
  const own = 'example.com/tools/demo';

  it('resolves through its signed list from a host that is not a forge', async () => {
    const release = buildRelease({ project: own, version: '1.0.0', key });
    publish(
      web,
      release,
      'https://dl.example.com/1.0.0/packslip.sigstore.json',
    );
    web.set(
      'https://example.com/.well-known/packslip/tools/demo.json',
      buildList({
        project: own,
        key,
        sequence: 1,
        entries: [
          {
            version: '1.0.0',
            url: 'https://dl.example.com/1.0.0/packslip.sigstore.json',
            release,
          },
        ],
      }),
    );
    const resolved = await resolveRelease(
      input({ project: parseProject(own) }),
    );
    expect(resolved.statement.project).toBe(own);
    expect(resolved.list).toMatchObject({ sequence: 1 });
  });

  it('refuses a statement for another name, since nothing but the pin ties a domain project to a signer', async () => {
    const release = buildRelease({
      project: 'example.com/tools/other',
      version: '1.0.0',
      key,
    });
    publish(
      web,
      release,
      'https://dl.example.com/1.0.0/packslip.sigstore.json',
    );
    web.set(
      'https://example.com/.well-known/packslip/tools/demo.json',
      buildList({
        project: own,
        key,
        sequence: 1,
        entries: [
          {
            version: '1.0.0',
            url: 'https://dl.example.com/1.0.0/packslip.sigstore.json',
            release,
          },
        ],
      }),
    );
    await expect(
      resolveRelease(input({ project: parseProject(own) })),
    ).rejects.toMatchObject({
      code: 'PROJECT_MISMATCH',
    });
  });
});

describe('a real keyless release (jdx/hk 2.5.0), resolved through an emulated GitHub', () => {
  const hk = readFileSync(
    new URL('./fixtures/real/hk-2.5.0.sigstore.json', import.meta.url),
  );
  const HK_PIN = 'ps1_snirenkjwr7m5ozgcufameodnm';
  const hkHost = detectHost({
    platform: 'linux',
    arch: 'x64',
    glibcVersion: '2.36',
    kernelRelease: '6.1.0',
    env: {},
  });

  function world(): void {
    githubWorld(web, {
      repo: 'jdx/hk',
      releases: [{ tag: 'v2.5.0' }],
      latestTag: 'v2.5.0',
    });
    web.set(
      'https://github.com/jdx/hk/releases/download/v2.5.0/packslip.sigstore.json',
      hk,
    );
  }

  const hkInput = (over: Partial<ResolveInput> = {}): ResolveInput => ({
    project: parseProject('github.com/jdx/hk'),
    request: { spec: 'latest', prerelease: false },
    signer: {},
    fetcher: web,
    now: NOW,
    host: {
      ...hkHost,
      facts: { ...hkHost.facts, hasLibrary: () => true },
    },
    formats: ['tar.gz', 'zip'],
    ...over,
  });

  it('verifies with nothing but the project name: the forge says who may sign', async () => {
    world();
    const resolved = await resolveRelease(hkInput());
    expect(resolved.statement).toMatchObject({
      project: 'github.com/jdx/hk',
      version: '2.5.0',
    });
    expect(resolved.artifact.name).toBe('hk-x86_64-unknown-linux-gnu.tar.gz');
    expect(resolved.verified.logged).toBe(true);
    expect(resolved.memory.signer).toMatchObject({
      scheme: 'sigstore-oidc',
      identity: '.github/workflows/release.yml',
      repositoryId: '922514152',
      pinWorkflow: true,
    });
    const resources = resolved.resources
      .map((group) => `${group.kind}:${group.identity}`)
      .sort();
    expect(resources).toContain('completion:hk\u0000zsh');
    expect(resources).toContain('skill:hk-configure');
    expect(resources).toContain('cli-spec:hk\u0000usage');
  });

  it('accepts the right signer fingerprint and refuses another before trusting the release', async () => {
    world();
    await expect(
      resolveRelease(hkInput({ signer: { pins: [HK_PIN] } })),
    ).resolves.toBeDefined();
    await expect(
      resolveRelease(
        hkInput({ signer: { pins: ['ps1_kwhjac5qpc45qetfh6ppwisi6a'] } }),
      ),
    ).rejects.toMatchObject({ code: 'PIN_MISMATCH' });
  });

  it('refuses a request for a different name when nothing shows it is the same repository', async () => {
    world();
    githubWorld(web, { repo: 'other/hk', releases: [{ tag: 'v2.5.0' }] });
    web.set(
      'https://github.com/other/hk/releases/download/v2.5.0/packslip.sigstore.json',
      hk,
    );
    await expect(
      resolveRelease(hkInput({ project: parseProject('github.com/other/hk') })),
    ).rejects.toMatchObject({ code: 'PROJECT_MISMATCH' });
  });

  it('follows a rename when the pinned repository ID proves it is the same repository', async () => {
    githubWorld(web, { repo: 'old/hk', releases: [{ tag: 'v2.5.0' }] });
    web.set(
      'https://github.com/old/hk/releases/download/v2.5.0/packslip.sigstore.json',
      hk,
    );
    const memory: TrustMemory = {
      project: 'github.com/old/hk',
      signer: {
        scheme: 'sigstore-oidc',
        identity: '.github/workflows/release.yml',
        issuer: 'https://token.actions.githubusercontent.com',
        repositoryId: '922514152',
        pinWorkflow: true,
      },
      attestedBy: 'vendor',
      logged: true,
      provenance: false,
    };
    const resolved = await resolveRelease(
      hkInput({ project: parseProject('github.com/old/hk'), memory }),
    );
    expect(resolved.notes.join('\n')).toContain(
      'github.com/old/hk is now github.com/jdx/hk',
    );
    expect(resolved.statement.project).toBe('github.com/jdx/hk');
  });

  it('refuses a recreated name: the same name with a different repository ID is another project', async () => {
    world();
    const memory: TrustMemory = {
      project: 'github.com/jdx/hk',
      signer: {
        scheme: 'sigstore-oidc',
        identity: '.github/workflows/release.yml',
        issuer: 'https://token.actions.githubusercontent.com',
        repositoryId: '1',
        pinWorkflow: true,
      },
      attestedBy: 'vendor',
      logged: true,
      provenance: false,
    };
    await expect(resolveRelease(hkInput({ memory }))).rejects.toMatchObject({
      code: 'SIGNER_MISMATCH',
      message: expect.stringContaining('recreated name'),
    });
  });

  it('refuses when the signing workflow differs from the one remembered', async () => {
    world();
    const memory: TrustMemory = {
      project: 'github.com/jdx/hk',
      signer: {
        scheme: 'sigstore-oidc',
        identity: '.github/workflows/publish.yml',
        issuer: 'https://token.actions.githubusercontent.com',
        repositoryId: '922514152',
        pinWorkflow: true,
      },
      attestedBy: 'vendor',
      logged: true,
      provenance: false,
    };
    await expect(resolveRelease(hkInput({ memory }))).rejects.toBeInstanceOf(
      TrustChangeError,
    );
  });

  it('refuses a key-signed bundle where a keyless signer is expected, and the reverse', async () => {
    world();
    const other = generateTestKey();
    await expect(
      resolveRelease(
        hkInput({
          signer: { publicKey: other.publicKeyFile, allowUnlogged: true },
        }),
      ),
    ).rejects.toMatchObject({ code: 'SIGNER_MISMATCH' });
  });
});

describe('keeping the resolved result honest', () => {
  it('returns the exact bytes that were verified, so the caller stores what was checked', async () => {
    const [release] = publishAll(['1.0.0']);
    const resolved = await resolveRelease(input());
    expect(
      Buffer.from(resolved.bundle).equals(Buffer.from(release!.bundle)),
    ).toBe(true);
    expect(resolved.verified.bundleDigest).toBe(
      `sha256:${release!.bundleSha256}`,
    );
  });
});

export type { ResolvedRelease };
