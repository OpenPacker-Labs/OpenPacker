/**
 * Differential tests against the reference `packslip` CLI.
 *
 * Skipped unless PACKSLIP_ORACLE_BIN names a packslip executable (1.5.1 or
 * newer), so the offline gates never depend on a downloaded binary. Run them
 * after changing verification or statement decoding:
 *
 *   PACKSLIP_ORACLE_BIN=/path/to/packslip npx vitest run packages/packslip/test/oracle.test.ts
 *
 * Each test asks the reference implementation for the answer and requires this
 * package to agree, in both directions: what the reference accepts, this
 * package must accept, and what it refuses, this package must refuse.
 */
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseCanonicalJson } from '@openpacker/canonical';
import {
  decodeReleaseStatement,
  selectArtifact,
  verifyBundle,
} from '../src/index.js';
import {
  generateTestKey,
  signBundle,
  withPayload,
} from '@openpacker/packslip-testkit';

const bin = process.env.PACKSLIP_ORACLE_BIN;
const run = (args: string[], cwd?: string) =>
  spawnSync(bin ?? 'packslip', args, {
    encoding: 'utf8',
    ...(cwd !== undefined && { cwd }),
  });

const dirs: string[] = [];
const scratch = () => {
  const directory = mkdtempSync(join(tmpdir(), 'packslip-oracle-'));
  dirs.push(directory);
  return directory;
};
afterAll(() => {
  for (const directory of dirs)
    rmSync(directory, { recursive: true, force: true });
});

const fixture = (path: string) =>
  join(new URL('./fixtures/', import.meta.url).pathname, path);

describe.skipIf(bin === undefined)(
  'agreement with the reference packslip CLI',
  () => {
    it('is the version the vectors were written against', () => {
      expect(run(['version']).stdout).toMatch(/^packslip 1\.\d+\.\d+/u);
    });

    it('agrees on a real keyless bundle: accepted, same repository ID and fingerprint', () => {
      const bundle = fixture('real/hk-2.5.0.sigstore.json');
      const reference = run([
        'verify',
        bundle,
        '--identity-prefix',
        'https://github.com/jdx/hk/',
        '--issuer',
        'https://token.actions.githubusercontent.com',
        '--pin',
        'ps1_snirenkjwr7m5ozgcufameodnm',
      ]);
      expect(reference.status).toBe(0);
      expect(reference.stdout).toContain(
        'repository https://github.com/jdx/hk (id 922514152)',
      );
      const mine = verifyBundle({
        bundle: readFileSync(bundle),
        expectation: {
          scheme: 'sigstore-oidc',
          issuer: 'https://token.actions.githubusercontent.com',
          identityPrefix: 'https://github.com/jdx/hk/',
          pins: ['ps1_snirenkjwr7m5ozgcufameodnm'],
        },
      });
      expect(mine.signer.repositoryId).toBe('922514152');
      const printed = run([
        'pin',
        bundle,
        '--identity-prefix',
        'https://github.com/jdx/hk/',
        '--issuer',
        'https://token.actions.githubusercontent.com',
      ]);
      expect(printed.stdout).toContain(
        mine.signer.fingerprint ?? 'no fingerprint',
      );
    });

    it('agrees on refusing a keyless bundle under the wrong identity or pin', () => {
      const bundle = fixture('real/hk-2.5.0.sigstore.json');
      for (const [flags, expectation] of [
        [
          [
            '--identity-prefix',
            'https://github.com/jdx/mise/',
            '--issuer',
            'https://token.actions.githubusercontent.com',
          ],
          { identityPrefix: 'https://github.com/jdx/mise/' },
        ],
        [
          [
            '--identity-prefix',
            'https://github.com/jdx/hk/',
            '--issuer',
            'https://token.actions.githubusercontent.com',
            '--pin',
            'ps1_kwhjac5qpc45qetfh6ppwisi6a',
          ],
          {
            identityPrefix: 'https://github.com/jdx/hk/',
            pins: ['ps1_kwhjac5qpc45qetfh6ppwisi6a'],
          },
        ],
      ] as const) {
        expect(run(['verify', bundle, ...flags]).status).not.toBe(0);
        expect(() =>
          verifyBundle({
            bundle: readFileSync(bundle),
            expectation: {
              scheme: 'sigstore-oidc',
              issuer: 'https://token.actions.githubusercontent.com',
              ...expectation,
            },
          }),
        ).toThrow();
      }
    });

    it('accepts bundles this package’s test signer writes, and refuses a tampered one, as the reference does', () => {
      const directory = scratch();
      const key = generateTestKey();
      writeFileSync(join(directory, 'k.pub'), key.publicKeyFile);
      const statement = parseCanonicalJson(
        verifyBundle({
          bundle: readFileSync(
            fixture('demo-key-signed/packslip.sigstore.json'),
          ),
          expectation: {
            scheme: 'sigstore-key',
            publicKey: readFileSync(
              fixture('demo-key-signed/demo.pub'),
              'utf8',
            ),
          },
          allowUnlogged: true,
        }).payload,
      );
      // A statement declares its signer, and the reference refuses one that
      // disagrees with the key that signed it, so the fixture must declare this key.
      const declared = JSON.parse(JSON.stringify(statement));
      declared.predicate.identity.key_id = key.keyId;
      const good = signBundle(declared, key);
      writeFileSync(join(directory, 'good.json'), good);
      expect(
        run([
          'verify',
          join(directory, 'good.json'),
          '--pubkey',
          join(directory, 'k.pub'),
          '--allow-unlogged',
        ]).status,
      ).toBe(0);

      const bad = withPayload(good, {
        ...declared,
        tampered: true,
      });
      writeFileSync(join(directory, 'bad.json'), bad);
      expect(
        run([
          'verify',
          join(directory, 'bad.json'),
          '--pubkey',
          join(directory, 'k.pub'),
          '--allow-unlogged',
        ]).status,
      ).not.toBe(0);
      expect(() =>
        verifyBundle({
          bundle: bad,
          expectation: { scheme: 'sigstore-key', publicKey: key.publicKeyFile },
          allowUnlogged: true,
        }),
      ).toThrow();

      // Without --allow-unlogged both refuse the same good bundle.
      expect(
        run([
          'verify',
          join(directory, 'good.json'),
          '--pubkey',
          join(directory, 'k.pub'),
        ]).status,
      ).not.toBe(0);
      expect(() =>
        verifyBundle({
          bundle: good,
          expectation: { scheme: 'sigstore-key', publicKey: key.publicKeyFile },
        }),
      ).toThrow();
    });

    it('decodes every statement the reference writes for a rich release, and selects the same artifacts', () => {
      const directory = scratch();
      const stage = (name: string, files: Record<string, string>) => {
        const root = join(directory, 'stage', name);
        for (const [path, contents] of Object.entries(files)) {
          mkdirSync(join(root, path, '..'), { recursive: true });
          writeFileSync(join(root, path), contents, { mode: 0o755 });
        }
        return root;
      };
      const linux = stage('tool-1.2.3', {
        'bin/tool': '#!/bin/sh\n',
        'share/man/man1/tool.1': '.TH T 1',
        'share/zsh/_tool': '#compdef tool',
        'skills/tool/SKILL.md': '# tool',
      });
      const win = stage('tool-1.2.3-win', {
        'bin/tool.exe': 'MZ',
        'share/man/tool.1': '.TH T 1',
      });
      expect(
        spawnSync('tar', [
          '-C',
          join(directory, 'stage'),
          '-czf',
          join(directory, 'tool-1.2.3-linux-x64.tar.gz'),
          'tool-1.2.3',
        ]).status,
      ).toBe(0);
      expect(
        spawnSync('tar', [
          '-C',
          join(directory, 'stage'),
          '-czf',
          join(directory, 'tool-1.2.3-linux-x64-fips.tar.gz'),
          'tool-1.2.3',
        ]).status,
      ).toBe(0);
      expect(
        spawnSync(
          'zip',
          [
            '-qr',
            join(directory, 'tool-1.2.3-windows-x64.zip'),
            'tool-1.2.3-win',
          ],
          { cwd: join(directory, 'stage') },
        ).status,
      ).toBe(0);
      expect(linux).toContain('tool-1.2.3');
      expect(win).toContain('tool-1.2.3-win');
      const key = run(['keygen', '-o', join(directory, 'k.key')]);
      expect(key.status).toBe(0);
      const created = run(
        [
          'create',
          '--project',
          'github.com/acme/tool',
          '--version',
          '1.2.3',
          '--key',
          join(directory, 'k.key'),
          '--no-log',
          '--source-repo',
          'https://github.com/acme/tool',
          '--commit',
          'a'.repeat(40),
          '--tag',
          'v1.2.3',
          '--bin',
          'tool',
          '--require',
          'bin:java@17',
          '--resource',
          'man=archive:tool-1.2.3/share/man/man1/tool.1',
          '--resource',
          'completion/zsh=archive:tool-1.2.3/share/zsh/_tool',
          '--resource',
          'skill/tool=repo:skills/tool',
          '--url-base',
          'https://dl.example.com/tool/1.2.3',
          '--out',
          join(directory, 'out'),
          join(directory, 'tool-1.2.3-linux-x64.tar.gz:linux/x86_64/gnu'),
          `${join(directory, 'tool-1.2.3-linux-x64-fips.tar.gz')}:linux/x86_64/gnu@fips`,
          `${join(directory, 'tool-1.2.3-windows-x64.zip')}:windows/x86_64`,
        ],
        directory,
      );
      expect(created.stderr + created.stdout).toContain('wrote');
      expect(created.status).toBe(0);

      const verified = verifyBundle({
        bundle: readFileSync(join(directory, 'out/packslip.sigstore.json')),
        expectation: {
          scheme: 'sigstore-key',
          publicKey: readFileSync(join(directory, 'k.pub'), 'utf8'),
        },
        allowUnlogged: true,
      });
      const statement = decodeReleaseStatement(
        parseCanonicalJson(verified.payload),
      );
      expect(statement.artifacts.map((a) => a.variant ?? a.os)).toEqual([
        'linux',
        'fips',
        'windows',
      ]);
      const choose = (os: string, variant?: string) =>
        selectArtifact(statement.artifacts, {
          host: { os, arch: 'x86_64', ...(os === 'linux' && { libc: 'gnu' }) },
          formats: ['tar.gz', 'zip'],
          ...(variant !== undefined && { variant }),
        }).artifact.name;
      expect(choose('linux')).toBe('tool-1.2.3-linux-x64.tar.gz');
      expect(choose('linux', 'fips')).toBe('tool-1.2.3-linux-x64-fips.tar.gz');
      expect(choose('windows')).toBe('tool-1.2.3-windows-x64.zip');
      expect(statement.artifacts[0]?.requires?.bin).toEqual([
        { name: 'java', min: '17' },
      ]);
      expect(statement.source).toMatchObject({
        commit: 'a'.repeat(40),
        tag: 'v1.2.3',
      });
    });
  },
);
