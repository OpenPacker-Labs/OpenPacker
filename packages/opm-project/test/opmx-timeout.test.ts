import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxBackend } from '@openpacker/sandbox';
import {
  OpmError,
  parseManifest,
  runSandboxedPackageProcess,
  serializeManifest,
} from '../src/index.js';

/**
 * A tool opmx runs has no wall-clock limit unless one is asked for: `opmx
 * --timeout <ms>`, else `[sandbox] opmx_timeout_ms`. The project's
 * `timeout_ms` bounds an install's lifecycle scripts, and opmx used to take it
 * too, ten minutes when unset, which ended any server run that long.
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

async function limitFor(input: {
  sandbox?: string;
  timeoutMs?: number;
}): Promise<number | undefined> {
  const { backend, given } = recording();
  const policy =
    input.sandbox === undefined ? undefined : policyOf(input.sandbox);
  const cwd = await mkdtemp(join(tmpdir(), 'opm-opmx-timeout-'));
  temps.push(cwd);
  await runSandboxedPackageProcess({
    argv: ['/bin/true'],
    cwd,
    backend,
    ...(!(policy === undefined) && { policy }),
    ...(!(input.timeoutMs === undefined) && { timeoutMs: input.timeoutMs }),
  });
  return given[0];
}

describe('the wall-clock limit of a tool opmx runs', () => {
  it('is none by default, with or without a project', async () => {
    expect(await limitFor({})).toBeUndefined();
    expect(await limitFor({ sandbox: 'project_write = false' })).toBe(
      undefined,
    );
  });

  it('is not the timeout_ms lifecycle scripts get', async () => {
    expect(await limitFor({ sandbox: 'timeout_ms = 200' })).toBeUndefined();
  });

  it('is the project’s opmx_timeout_ms', async () => {
    expect(await limitFor({ sandbox: 'opmx_timeout_ms = 300000' })).toBe(
      300_000,
    );
    expect(await limitFor({ sandbox: 'opmx_timeout_ms = 0' })).toBeUndefined();
  });

  it('is --timeout over the project’s, 0 included', async () => {
    const sandbox = 'opmx_timeout_ms = 300000';
    expect(await limitFor({ sandbox, timeoutMs: 400 })).toBe(400);
    expect(await limitFor({ sandbox, timeoutMs: 0 })).toBeUndefined();
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
