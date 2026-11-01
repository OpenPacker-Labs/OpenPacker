import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_CODES, runOpm } from '../src/opm.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

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

describe('opm publish and yank', () => {
  it('documents publish and yank after pack in help', async () => {
    const cap = capture();
    expect(await runOpm(['help'], cap.io)).toBe(EXIT_CODES.success);
    expect(cap.out).toMatch(/opm publish --from <dir>/u);
    expect(cap.out).toMatch(/opm yank <exact-purl>/u);
    expect(cap.out).toMatch(/OPM_PREX_REGISTRY/u);
  });

  it('refuses --offline publish and yank', async () => {
    const cap = capture();
    expect(
      await runOpm(
        [
          'publish',
          '--offline',
          '--from',
          '/tmp',
          '--registry',
          'http://127.0.0.1:9/',
        ],
        cap.io,
      ),
    ).toBe(EXIT_CODES.unavailable);
    expect(cap.err).toMatch(/refuses --offline/u);
    const yank = capture();
    expect(
      await runOpm(
        [
          'yank',
          'pkg:npm/demo@1.0.0',
          '--offline',
          '--registry',
          'http://127.0.0.1:9/',
        ],
        yank.io,
      ),
    ).toBe(EXIT_CODES.unavailable);
  });

  it('refuses native npmjs/PyPI/crates.io registries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opm-cli-publish-'));
    temps.push(root);
    const cap = capture();
    expect(
      await runOpm(
        [
          'publish',
          '--from',
          root,
          '--registry',
          'https://registry.npmjs.org/',
        ],
        cap.io,
        root,
      ),
    ).toBe(EXIT_CODES.verificationFailed);
    expect(cap.err).toMatch(/native registry/u);
  });

  it('refuses yank without an exact version', async () => {
    const cap = capture();
    expect(
      await runOpm(
        ['yank', 'pkg:npm/demo', '--registry', 'http://127.0.0.1:9/'],
        cap.io,
      ),
    ).toBe(EXIT_CODES.invalidInput);
    expect(cap.err).toMatch(/exact PURL/u);
  });

  it('requires --from or --pack', async () => {
    const cap = capture();
    expect(
      await runOpm(['publish', '--registry', 'http://127.0.0.1:9/'], cap.io),
    ).toBe(EXIT_CODES.invalidInput);
    expect(cap.err).toMatch(/--from <dir> or --pack/u);
  });

  it('requires --package-version when packing', async () => {
    const cap = capture();
    expect(
      await runOpm(
        ['publish', '--pack', 'npm', '--registry', 'http://127.0.0.1:9/'],
        cap.io,
      ),
    ).toBe(EXIT_CODES.invalidInput);
    expect(cap.err).toMatch(/--package-version/u);
  });
});
