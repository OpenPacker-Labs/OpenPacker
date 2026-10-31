import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxBackend } from '@openpacker/sandbox';
import {
  OpmError,
  opmxRunTimeout,
  parseManifest,
  runSandboxedPackageProcess,
  serializeManifest,
} from '../src/index.js';

/**
 * A tool opmx runs has no wall-clock limit unless one is asked for:
 * `opmx --timeout <ms>`, else `[sandbox] opmx_timeout_ms`, else a
 * `[sandbox] timeout_ms` the project sets (a project that bounds its runs in
 * CI keeps that bound), else none. Only the default ten minutes, which is for
 * what runs unattended, stops applying; it ended any server run that long.
 * The library leaves the choice to its caller: `runSandboxedPackageProcess`
 * takes the limit it is to apply, and applies no project setting of its own.
 */

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A backend that records the limit it was given and runs nothing. */
function recording() {
  const given: (number | undefined)[] = [];
  const backend: SandboxBackend = {
    id: 'native-bwrap',
    async run(input) {
      given.push(input.timeoutMs);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
  return { backend, given };
}

const policyOf = (sandbox: string) =>
  parseManifest(
    `[project]\nname = "timeout"\necosystems = ["npm"]\n\n[sandbox]\n${sandbox}\n`,
  ).policy;

/** The limit the backend is given for a run that asks for `timeoutMs`. */
async function given(timeoutMs: number, sandbox?: string) {
  const { backend, given } = recording();
  const policy = sandbox === undefined ? undefined : policyOf(sandbox);
  const cwd = await mkdtemp(join(tmpdir(), 'opm-opmx-timeout-'));
  temps.push(cwd);
  await runSandboxedPackageProcess({
    argv: ['/bin/true'],
    cwd,
    backend,
    timeoutMs,
    ...(!(policy === undefined) && { policy }),
  });
  return given[0];
}

/** What opmx asks for, with `sandbox` in opm.toml and `flag` given. */
const opmxLimit = (sandbox?: string, flag?: number) =>
  opmxRunTimeout(sandbox === undefined ? undefined : policyOf(sandbox), flag);

describe('the wall-clock limit of a tool opmx runs', () => {
  it('is none by default, with or without a project', () => {
    expect(opmxLimit()).toBe(0);
    expect(opmxLimit('project_write = false')).toBe(0);
  });

  it('is the project’s timeout_ms when it sets one', () => {
    expect(opmxLimit('timeout_ms = 200')).toBe(200);
  });

  it('is the project’s opmx_timeout_ms over its timeout_ms', () => {
    expect(opmxLimit('timeout_ms = 200\nopmx_timeout_ms = 300000')).toBe(
      300_000,
    );
    expect(opmxLimit('timeout_ms = 200\nopmx_timeout_ms = 0')).toBe(0);
  });

  it('is --timeout over both, 0 included', () => {
    const sandbox = 'timeout_ms = 200\nopmx_timeout_ms = 300000';
    expect(opmxLimit(sandbox, 400)).toBe(400);
    expect(opmxLimit(sandbox, 0)).toBe(0);
  });

  it('refuses a timeout_ms that is not whole milliseconds, naming it', () => {
    expect(() => opmxLimit('timeout_ms = -1')).toThrow(/sandbox\.timeout_ms/u);
  });
});

describe('runSandboxedPackageProcess', () => {
  it('applies the limit its caller gives, whatever the project sets', async () => {
    const sandbox = 'timeout_ms = 200\nopmx_timeout_ms = 300000';
    expect(await given(400, sandbox)).toBe(400);
    expect(await given(0, sandbox)).toBeUndefined();
  });

  it('refuses a run whose caller chose no limit', async () => {
    const { backend, given: seen } = recording();
    await expect(
      runSandboxedPackageProcess(
        // SAFETY: a caller that leaves out the required limit, as JavaScript can.
        {
          argv: ['/bin/true'],
          cwd: tmpdir(),
          backend,
        } as unknown as Parameters<typeof runSandboxedPackageProcess>[0],
      ),
    ).rejects.toThrow(/The run timeout/u);
    expect(seen).toEqual([]);
  });
});

describe('[sandbox] opmx_timeout_ms', () => {
  it('round-trips through opm.toml', () => {
    const manifest = parseManifest(
      '[project]\nname = "t"\necosystems = ["npm"]\n\n[sandbox]\nopmx_timeout_ms = 300000\n',
    );
    expect(serializeManifest(manifest)).toContain('opmx_timeout_ms = 300000');
    // SAFETY: The extended sandbox knobs live on PolicyInput untyped (toml.ts).
    const again = parseManifest(serializeManifest(manifest)).policy as {
      opmxTimeoutMs?: number;
    };
    expect(again.opmxTimeoutMs).toBe(300_000);
  });

  it.each(['-1', '1.5', '"300"', '2147483648'])(
    'refuses %s, naming the key',
    (value) => {
      let error: unknown;
      try {
        policyOf(`opmx_timeout_ms = ${value}`);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(OpmError);
      expect((error as OpmError).code).toBe('INVALID_MANIFEST');
      expect((error as OpmError).message).toContain('opmx_timeout_ms');
    },
  );
});

describe('[sandbox] timeout_ms', () => {
  it.each(['-1', '1.5', '"300"', '2147483648', '1e12'])(
    'refuses %s when opm.toml is read, naming the key',
    (value) => {
      let error: unknown;
      try {
        policyOf(`timeout_ms = ${value}`);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(OpmError);
      // SAFETY: just checked to be an OpmError.
      expect((error as OpmError).code).toBe('INVALID_MANIFEST');
      // SAFETY: as above.
      expect((error as OpmError).message).toContain('timeout_ms');
    },
  );

  it('takes whole milliseconds up to 2147483647, 0 for none', () => {
    for (const value of [0, 1, 600_000, 2_147_483_647]) {
      // SAFETY: The extended sandbox knobs live on PolicyInput untyped (toml.ts).
      const policy = policyOf(`timeout_ms = ${value}`) as {
        timeoutMs?: number;
      };
      expect(policy.timeoutMs).toBe(value);
    }
  });
});
