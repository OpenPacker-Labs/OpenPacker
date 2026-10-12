import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectNpmLifecycleScripts,
  hasLifecycleScripts,
  lifecycleScriptsAllowed,
  runDeclaredLifecycleScripts,
  runLifecycleScript,
} from '../src/lifecycle.js';
import { observedSandboxForGeneration } from '../src/install.js';
import { runSandboxedPackageProcess } from '../src/sandbox-run.js';
import type { PolicyInput } from '@openpacker/contracts';
import { createMockBackend, type SandboxOutcome } from '@openpacker/sandbox';

// SAFETY: The surrounding boundary establishes the asserted domain contract.
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
  it('configured default refuses scripts on install', async () => {
    const { defaultManifest, defaultSupplyChainPolicyInput } = await import(
      '../src/index.js'
    );
    expect(defaultManifest().policy?.allowLifecycleScripts).toBe(false);
    expect(defaultSupplyChainPolicyInput().allowLifecycleScripts).toBe(false);
    expect(lifecycleScriptsAllowed(undefined, 'pkg:npm/evil')).toBe(false);
    expect(
      lifecycleScriptsAllowed(defaultManifest().policy, 'pkg:npm/evil'),
    ).toBe(false);
    expect(
      lifecycleScriptsAllowed(
        { ...allowPolicy, allowLifecycleScripts: true },
        'pkg:npm/evil',
      ),
    ).toBe(false);
  });

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
  it('throws SANDBOX_UNAVAILABLE when fail-closed and jail is not enforced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opm-life-unenforced-'));
    await expect(
      runLifecycleScript({
        event: 'postinstall',
        script: 'echo hi',
        packageDir: dir,
        packageId: 'pkg:npm/esbuild',
        policy: {
          ...allowPolicy,
          sandboxMode: 'fail-closed',
          sandboxRequired: true,
        },
        backend: createMockBackend({ unavailable: true }),
      }),
    ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
  });

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

  it('runSandboxedPackageProcess denies project writes by default', async () => {
    const project = await mkdtemp(join(tmpdir(), 'opm-run-ro-'));
    const victim = join(project, 'src.js');
    await writeFile(victim, 'good\n');
    // Without a jail this must throw rather than write. With a jail the
    // project tree stays RO. Either way the file stays good.
    try {
      await runSandboxedPackageProcess({
        argv: [
          process.execPath,
          '-e',
          `require('fs').writeFileSync(${JSON.stringify(victim)},'pwned')`,
        ],
        cwd: project,
        projectRoot: project,
        policy: allowPolicy,
      });
    } catch {
      // fail-closed without a backend, or the write itself failed
    }
    expect(await readFile(victim, 'utf8')).toBe('good\n');
  });

  it('runSandboxedPackageProcess refuses when the jail is not enforced', async () => {
    const project = await mkdtemp(join(tmpdir(), 'opm-run-unenforced-'));
    await expect(
      runSandboxedPackageProcess({
        argv: [process.execPath, '-e', 'process.exit(0)'],
        cwd: project,
        projectRoot: project,
        policy: {
          ...allowPolicy,
          sandboxMode: 'fail-closed',
        },
        backend: createMockBackend({ unavailable: true }),
      }),
    ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
  });

  it('records policyDigest without claiming enforcement when scripts did not run', async () => {
    const summary = await observedSandboxForGeneration({
      policy: allowPolicy,
      lifecycleScriptsExecuted: false,
      outcomes: [],
    });
    expect(summary.policyDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(summary.lifecycleScriptsExecuted).toBe(false);
    expect(summary.enforced).toBeUndefined();
    expect(summary.backends).toBeUndefined();
  });

  it('does not infer enforced=true from scripts running — only from outcomes', async () => {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const ambient = {
      exitCode: 0,
      stdout: '',
      stderr: '',
      backend: 'none',
      profile: 'package-exec',
      enforced: false,
      containmentLimited: true,
      policyDigest: { algorithm: 'sha256', value: '0'.repeat(64) },
      losses: [],
      degraded: true,
    } as SandboxOutcome;
    const summary = await observedSandboxForGeneration({
      policy: allowPolicy,
      lifecycleScriptsExecuted: true,
      outcomes: [ambient],
    });
    expect(summary.enforced).toBe(false);
    expect(summary.backends).toEqual(['none']);
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

describe('containment withdrawn off Linux', () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    for (const restore of restores.splice(0)) restore();
  });
  function spoofPlatform(value: NodeJS.Platform): void {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value });
    restores.push(() => {
      if (original) Object.defineProperty(process, 'platform', original);
    });
  }
  const failClosed: PolicyInput = {
    ...allowPolicy,
    sandboxMode: 'fail-closed',
    sandboxRequired: true,
    sandboxPrefer: 'native',
  };

  it('tells a lifecycle script on macOS why it did not run and what to use instead', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opm-life-macos-'));
    spoofPlatform('darwin');
    const failure = await runLifecycleScript({
      event: 'postinstall',
      script: 'echo hi',
      packageDir: dir,
      packageId: 'pkg:npm/esbuild',
      policy: failClosed,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(String(failure)).toMatch(
      /sandbox was not enforced \(backend=none\)/u,
    );
    expect(String(failure)).toMatch(/withdrawn on macOS \(ADR 0036\)/u);
    expect(String(failure)).toMatch(/Run this on a Linux host/u);
  });

  it('tells opmx the same', async () => {
    const project = await mkdtemp(join(tmpdir(), 'opm-run-macos-'));
    spoofPlatform('darwin');
    const failure = await runSandboxedPackageProcess({
      argv: [process.execPath, '-e', 'process.exit(0)'],
      cwd: project,
      projectRoot: project,
      policy: failClosed,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(String(failure)).toMatch(/withdrawn on macOS \(ADR 0036\)/u);
    expect(String(failure)).toMatch(/`opm exec <bin>`/u);
  });

  it('adds nothing on Linux, where the jail exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opm-life-linux-'));
    const failure = await runLifecycleScript({
      event: 'postinstall',
      script: 'echo hi',
      packageDir: dir,
      packageId: 'pkg:npm/esbuild',
      policy: failClosed,
      backend: createMockBackend({ unavailable: true }),
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(String(failure)).not.toMatch(/withdrawn on/u);
  });
});
