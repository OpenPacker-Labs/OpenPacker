import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detectNpmLifecycleScripts,
  hasLifecycleScripts,
  lifecycleScriptsAllowed,
  runDeclaredLifecycleScripts,
  runLifecycleScript,
} from '../src/lifecycle.js';
import type { PolicyInput } from '@openpacker/contracts';

const allowPolicy: PolicyInput = {
  allowYanked: false,
  allowQuarantined: false,
  semanticLossMaximum: 'warning',
  requiredEvidence: [],
  allowLifecycleScripts: true,
  allowedLifecycleScriptPackages: [
    'pkg:npm/malicious-postinstall',
    'pkg:npm/esbuild',
  ],
  sandboxMode: 'fail-closed',
  sandboxRequired: true,
  sandboxPrefer: 'native',
  // @ts-expect-error extended knobs until schema lands
  strictLifecycleAllowlist: true,
} as PolicyInput;

describe('lifecycle policy gates', () => {
  it('refuses scripts unless allowlisted', () => {
    expect(
      lifecycleScriptsAllowed(
        { ...allowPolicy, allowLifecycleScripts: false },
        'pkg:npm/evil',
      ),
    ).toBe(false);
    expect(
      lifecycleScriptsAllowed(
        {
          ...allowPolicy,
          allowLifecycleScripts: false,
          allowedLifecycleScriptPackages: ['pkg:npm/esbuild'],
        },
        'pkg:npm/esbuild',
      ),
    ).toBe(true);
    expect(
      lifecycleScriptsAllowed(
        {
          ...allowPolicy,
          allowLifecycleScripts: false,
          allowedLifecycleScriptPackages: ['pkg:npm/esbuild'],
        },
        'pkg:npm/esbuild-postinstall',
      ),
    ).toBe(false);
  });

  it('detects npm lifecycle scripts from package/package.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opm-life-detect-'));
    await mkdir(join(dir, 'package'), { recursive: true });
    await writeFile(
      join(dir, 'package', 'package.json'),
      JSON.stringify({
        name: 'evil',
        scripts: { postinstall: 'node ./pwn.js' },
      }),
    );
    const declared = await detectNpmLifecycleScripts(dir);
    expect(hasLifecycleScripts(declared)).toBe(true);
    expect(declared.events.postinstall).toBe('node ./pwn.js');
  });
});

describe('lifecycle jail execution', () => {
  it('throws POLICY_DENIED when scripts are not allowlisted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opm-life-deny-'));
    await expect(
      runLifecycleScript({
        event: 'postinstall',
        script: 'echo hi',
        packageDir: dir,
        packageId: 'pkg:npm/evil',
        policy: {
          ...allowPolicy,
          allowLifecycleScripts: false,
          allowedLifecycleScriptPackages: [],
        },
      }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  it('contains a malicious postinstall that tries to write outside the package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opm-life-escape-'));
    const pkg = join(root, 'package');
    await mkdir(pkg, { recursive: true });
    const outside = join(root, 'pwned.txt');
    await writeFile(outside, 'safe\n');

    // Script tries to escape via relative and absolute paths.
    const script = [
      `const fs=require('fs');`,
      `const path=require('path');`,
      `try{fs.writeFileSync(${JSON.stringify(outside)},'PWNED');}catch(e){}`,
      `try{fs.writeFileSync(path.join(${JSON.stringify(root)},'also-pwned'),'x');}catch(e){}`,
      `fs.writeFileSync('local-ok.txt','inside');`,
      `process.exit(0);`,
    ].join('');

    await writeFile(join(pkg, 'pwn.js'), script);

    let threw: unknown;
    try {
      await runLifecycleScript({
        event: 'postinstall',
        script: 'node ./pwn.js',
        packageDir: pkg,
        packageId: 'pkg:npm/malicious-postinstall',
        policy: allowPolicy,
      });
    } catch (error) {
      threw = error;
    }

    // Either the jail denied the write (exit non-zero → LIFECYCLE_FAILED /
    // SANDBOX_UNAVAILABLE) or the write was contained. Host outside file must
    // remain untouched either way.
    expect(await readFile(outside, 'utf8')).toBe('safe\n');

    // If a jail was available and the script completed, only package-local
    // writes should exist.
    try {
      const local = await readFile(join(pkg, 'local-ok.txt'), 'utf8');
      expect(local).toBe('inside');
      expect(threw).toBeUndefined();
    } catch {
      // No local write: script failed under jail or sandbox unavailable —
      // still a secure outcome for fail-closed hosts without backends only
      // when we refused execution entirely.
      if (threw) {
        expect(threw).toMatchObject({
          code: expect.stringMatching(
            /LIFECYCLE_FAILED|SANDBOX_UNAVAILABLE|POLICY_DENIED/,
          ),
        });
      }
    }
  });

  it('skips unapproved declared scripts without executing them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opm-life-skip-'));
    await mkdir(join(dir, 'package'), { recursive: true });
    const marker = join(dir, 'package', 'ran');
    await writeFile(
      join(dir, 'package', 'package.json'),
      JSON.stringify({
        scripts: {
          postinstall: `node -e "require('fs').writeFileSync('ran','yes')"`,
        },
      }),
    );
    const declared = await detectNpmLifecycleScripts(dir);
    const result = await runDeclaredLifecycleScripts({
      declared,
      packageDir: join(dir, 'package'),
      packageId: 'pkg:npm/skipped',
      policy: { ...allowPolicy, allowLifecycleScripts: false },
    });
    expect(result.executed).toBe(false);
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
