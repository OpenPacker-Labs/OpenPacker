import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { initProject, parseManifest } from '@openpacker/opm-project';
import {
  FakeWeb,
  buildRelease,
  fakeFetch,
  generateTestKey,
  githubWorld,
  type TestKey,
} from '@openpacker/packslip-testkit';
import { EXIT_CODES, handleError, runOpm } from '../src/opm.js';
import { exitForError } from '../src/opmx.js';
import { runPackslipCommand } from '../src/commands/packslip.js';

const PROJECT = 'github.com/acme/tool';
const lookup = async () => [{ address: '140.82.112.3', family: 4 as const }];

let key: TestKey;
let web: FakeWeb;
let root: string;
const roots: string[] = [];

function capture() {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: { write: (s: string) => ((out += s), true) },
      stderr: { write: (s: string) => ((err += s), true) },
    },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

function args(...positionals: string[]) {
  const options = new Map<string, string | true>();
  const words: string[] = [];
  for (const word of positionals)
    if (word.startsWith('--')) options.set(word.slice(2), true);
    else words.push(word);
  return { positionals: words, options };
}

const transport = () => ({
  fetch: fakeFetch(web),
  lookup,
  now: () => '2026-10-11T00:00:00.000Z',
});

async function project(trust = true): Promise<void> {
  await initProject({ root, name: 'demo' });
  if (!trust) return;
  const { writeManifestFile } = await import('@openpacker/opm-project');
  const manifest = parseManifest(`
[project]
name = "demo"
ecosystems = ["packslip"]

[adapters.packslip.trust."${PROJECT}"]
public_key = "${key.publicKeyFile.split('\n').find((line) => !line.startsWith('untrusted'))}"
allow_unlogged = true

[options]
offline = false
layout = "opm"
`);
  await writeManifestFile(join(root, 'opm.toml'), manifest);
}

beforeEach(async () => {
  configureDefaultAdapters();
  key = generateTestKey();
  web = new FakeWeb();
  const releases = ['1.0.0', '1.1.0'].map((version) => ({
    tag: `v${version}`,
    release: buildRelease({
      project: PROJECT,
      version,
      key,
      baseUrl: `https://github.com/acme/tool/releases/download/v${version}`,
      artifacts: [{}],
    }),
  }));
  githubWorld(web, { repo: 'acme/tool', releases });
  root = await mkdtemp(join(tmpdir(), 'opm-packslip-cli-'));
  roots.push(root);
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('opm packslip verify', () => {
  it('shows who signed the newest release without installing anything', async () => {
    await project();
    const cap = capture();
    const code = await runPackslipCommand(
      args('verify', 'packslip:github.com/acme/tool'),
      cap.io,
      root,
      transport(),
    );
    expect(code).toBe(0);
    expect(cap.out).toContain('pkg:packslip/github.com/acme/tool@1.1.0');
    expect(cap.out).toContain(key.keyId);
    expect(cap.out).toMatch(/scheme\s+sigstore-key/u);
    expect(cap.out).toMatch(/executables\s+tool/u);
    expect(cap.out).toMatch(/no transparency-log entry/u);
    // Nothing installed, nothing locked.
    const lock = JSON.parse(
      await readFile(join(root, 'opm.lock.json'), 'utf8'),
    );
    expect(lock.packages).toEqual({});
  });

  it('verifies an exact version', async () => {
    await project();
    const cap = capture();
    await runPackslipCommand(
      args('verify', 'packslip:github.com/acme/tool@1.0.0'),
      cap.io,
      root,
      transport(),
    );
    expect(cap.out).toContain('@1.0.0');
  });

  it('writes the same facts as JSON for a script', async () => {
    await project();
    const cap = capture();
    await runPackslipCommand(
      args('verify', 'packslip:github.com/acme/tool@1.0.0', '--json'),
      cap.io,
      root,
      transport(),
    );
    expect(JSON.parse(cap.out)).toMatchObject({
      purl: 'pkg:packslip/github.com/acme/tool@1.0.0',
      signer: key.keyId,
      scheme: 'sigstore-key',
      logged: false,
      trustTier: 'registry-attested',
      executables: ['tool'],
    });
  });

  it('works outside a project, with only what the vendor and GitHub can prove', async () => {
    const cap = capture();
    // No project, so no trusted key: a key-signed release cannot be trusted.
    await expect(
      runPackslipCommand(
        args('verify', 'packslip:github.com/acme/tool@1.0.0'),
        cap.io,
        root,
        transport(),
      ),
    ).rejects.toMatchObject({ code: 'SIGNATURE_VERIFICATION_FAILED' });
  });

  it('needs a spec', async () => {
    await expect(
      runPackslipCommand(args('verify'), capture().io, root, transport()),
    ).rejects.toMatchObject({ code: 'INVALID_SPEC' });
  });

  it('needs a subcommand it knows', async () => {
    await expect(
      runPackslipCommand(args(), capture().io, root),
    ).rejects.toMatchObject({ code: 'INVALID_SPEC' });
    await expect(
      runPackslipCommand(args('frobnicate'), capture().io, root),
    ).rejects.toMatchObject({ code: 'INVALID_SPEC' });
  });
});

describe('opm packslip pin', () => {
  it('says plainly that a key-signed project has no fingerprint to pin', async () => {
    await project();
    await expect(
      runPackslipCommand(
        args('pin', 'packslip:github.com/acme/tool@1.0.0'),
        capture().io,
        root,
        transport(),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_SPEC',
      message: expect.stringContaining('public_key'),
    });
  });
});

describe('opm packslip pin --write', () => {
  it('takes no value: --write=false is refused, not read as a request to write', async () => {
    await project();
    const options = new Map<string, string | true>([['write', 'false']]);
    await expect(
      runPackslipCommand(
        { positionals: ['pin', 'packslip:github.com/acme/tool'], options },
        capture().io,
        root,
        transport(),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_SPEC',
      message: expect.stringContaining('takes no value'),
    });
  });

  it('is a flag, so it does not swallow the spec that follows it', async () => {
    await project();
    const cap = capture();
    // Offline, nothing is fetched: what matters is that the spec was read and
    // the failure is the network's, not "requires a packslip spec".
    const code = await runOpm(
      ['packslip', 'pin', '--write', '--offline', 'packslip:acme/tool'],
      cap.io,
      root,
    );
    expect(code).toBe(EXIT_CODES.unavailable);
    expect(cap.err).not.toContain('requires a packslip spec');
  });
});

describe('opm packslip approve', () => {
  it('leaves the rest of opm.toml meaning what it meant', async () => {
    await project();
    const path = join(root, 'opm.toml');
    await writeFile(
      path,
      `${await readFile(path, 'utf8')}
[sandbox]
enabled = true
mode = "fail-closed"

[sandbox.packages."pkg:npm/sharp"]
network = true
`,
    );
    await runPackslipCommand(
      args('approve', '0123456789abcdef'),
      capture().io,
      root,
    );
    const written = await readFile(path, 'utf8');
    // The grant is still for sharp. A key rewritten to `pkg_npm_sharp` would
    // have moved it to a package that does not exist and revoked it silently.
    expect(written).toContain('[sandbox.packages."pkg:npm/sharp"]');
    expect(parseManifest(written).policy?.sandboxPackageGrants).toEqual({
      'pkg:npm/sharp': { network: true },
    });
  });

  it('keeps an approval that was written as a bare string', async () => {
    await project();
    const manifest = parseManifest(
      await readFile(join(root, 'opm.toml'), 'utf8'),
    );
    const { writeManifestFile } = await import('@openpacker/opm-project');
    await writeManifestFile(join(root, 'opm.toml'), {
      ...manifest,
      adapterSettings: {
        packslip: {
          ...manifest.adapterSettings?.packslip,
          approvals: 'aaaaaaaaaaaaaaaa',
        },
      },
    });
    await runPackslipCommand(
      args('approve', '0123456789abcdef'),
      capture().io,
      root,
    );
    expect(
      parseManifest(await readFile(join(root, 'opm.toml'), 'utf8'))
        .adapterSettings?.packslip?.approvals,
    ).toEqual(['0123456789abcdef', 'aaaaaaaaaaaaaaaa']);
  });

  it('records one proposal id in the manifest, once', async () => {
    await project();
    const first = capture();
    expect(
      await runPackslipCommand(
        args('approve', '0123456789abcdef'),
        first.io,
        root,
      ),
    ).toBe(0);
    expect(first.out).toContain('Approved proposal 0123456789abcdef');
    const written = await readFile(join(root, 'opm.toml'), 'utf8');
    expect(written).toContain('approvals = ["0123456789abcdef"]');
    // The trust configuration that was already there is untouched.
    expect(written).toContain(`[adapters.packslip.trust."${PROJECT}"]`);

    const again = capture();
    await runPackslipCommand(
      args('approve', '0123456789abcdef'),
      again.io,
      root,
    );
    expect(again.out).toContain('already approved');
    expect(
      (await readFile(join(root, 'opm.toml'), 'utf8')).match(
        /0123456789abcdef/gu,
      ),
    ).toHaveLength(1);
  });

  it.each([
    ['too short', '0123'],
    ['not hexadecimal', 'zzzzzzzzzzzzzzzz'],
    ['uppercase', '0123456789ABCDEF'],
    ['missing', ''],
  ])('refuses an id that is %s', async (_label, id) => {
    await project();
    await expect(
      runPackslipCommand(args('approve', id), capture().io, root),
    ).rejects.toMatchObject({ code: 'INVALID_SPEC' });
  });

  it('needs a project to write to', async () => {
    await expect(
      runPackslipCommand(
        args('approve', '0123456789abcdef'),
        capture().io,
        root,
      ),
    ).rejects.toMatchObject({ code: 'NO_PROJECT' });
  });
});

describe('what a failure exits with', () => {
  const exit = (code: string) => {
    const error = Object.assign(new Error('boom'), { code });
    return handleError(error, capture().io);
  };

  it.each([
    ['SIGNATURE_VERIFICATION_FAILED', EXIT_CODES.verificationFailed],
    ['INVALID_PACKSLIP_METADATA', EXIT_CODES.verificationFailed],
    // Another registry's malformed response is not evidence of tampering, so
    // it stays what it was: a script alerting on 7 must not fire on a glitch.
    ['INVALID_PROVIDER_METADATA', EXIT_CODES.internal],
    ['DIGEST_MISMATCH', EXIT_CODES.verificationFailed],
    ['TRUST_CHANGE_REQUIRES_APPROVAL', EXIT_CODES.policyDenied],
    ['ARTIFACT_TOO_LARGE', EXIT_CODES.policyDenied],
    ['INVALID_PACKSLIP_INPUT', EXIT_CODES.invalidInput],
    ['VERSION_NOT_FOUND', EXIT_CODES.notFound],
    ['ARTIFACT_NOT_FOUND', EXIT_CODES.notFound],
    ['HOST_INCOMPATIBLE', EXIT_CODES.unsatisfiable],
    ['UPSTREAM_UNAVAILABLE', EXIT_CODES.unavailable],
    ['OFFLINE', EXIT_CODES.unavailable],
  ])('%s → %i', (code, expected) => {
    expect(exit(code)).toBe(expected);
  });

  it.each([
    ['SIGNATURE_VERIFICATION_FAILED', EXIT_CODES.verificationFailed],
    ['INVALID_PACKSLIP_METADATA', EXIT_CODES.verificationFailed],
    ['TRUST_CHANGE_REQUIRES_APPROVAL', EXIT_CODES.policyDenied],
    ['ARTIFACT_TOO_LARGE', EXIT_CODES.policyDenied],
    ['INVALID_PACKSLIP_INPUT', EXIT_CODES.invalidInput],
    ['VERSION_NOT_FOUND', EXIT_CODES.notFound],
    ['HOST_INCOMPATIBLE', EXIT_CODES.unsatisfiable],
    ['UPSTREAM_UNAVAILABLE', EXIT_CODES.unavailable],
    ['INVALID_PROVIDER_METADATA', EXIT_CODES.internal],
  ])('opmx: %s → %i, as opm does', (code, expected) => {
    expect(exitForError(Object.assign(new Error('boom'), { code }))).toBe(
      expected,
    );
  });

  it('tells a person which change to approve, in the message they see', async () => {
    const cap = capture();
    handleError(
      Object.assign(new Error('signer changed (proposal 0123456789abcdef)'), {
        code: 'TRUST_CHANGE_REQUIRES_APPROVAL',
      }),
      cap.io,
    );
    expect(cap.err).toContain('proposal 0123456789abcdef');
  });
});

describe('through the real entry point', () => {
  it('lists packslip among the registries it can use', async () => {
    const cap = capture();
    await runOpm(['--help'], cap.io, root);
    expect(cap.out).toContain('packslip');
    expect(cap.out).toContain('opm packslip verify');
  });

  it('refuses to read a registry while offline', async () => {
    const cap = capture();
    expect(
      await runOpm(
        ['versions', 'packslip:github.com/acme/tool', '--offline'],
        cap.io,
        root,
      ),
    ).toBe(EXIT_CODES.unavailable);
  });

  it('knows packslip is a command and asks for its subcommand', async () => {
    const cap = capture();
    expect(await runOpm(['packslip'], cap.io, root)).toBe(
      EXIT_CODES.invalidInput,
    );
    expect(cap.err).toContain('verify | pin | approve');
  });
});
