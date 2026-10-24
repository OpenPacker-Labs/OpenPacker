import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveOpmxPath, writeBinShims } from '../src/bins.js';

/**
 * A shim re-enters through `opmx`. From a source build (`node
 * apps/opm/dist/main.js`) the `opmx` beside the entry is a module tsc wrote,
 * with no execute bit, and the shim spawned it as a program: `spawn …
 * EACCES`, exit 78, for every `.opm/bin/<tool>`. A shim starts a JavaScript
 * `opmx` with Node, and finds the file the `opmx` bin names.
 */

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A build directory: `main.js`, and an `opmx` that prints its arguments. */
async function build(names: readonly string[]): Promise<string> {
  const dist = await mkdtemp(join(tmpdir(), 'opm-shim-build-'));
  temps.push(dist);
  await writeFile(join(dist, 'main.js'), '');
  for (const name of names)
    await writeFile(
      join(dist, name),
      `console.log(${JSON.stringify(name)}, JSON.stringify(process.argv.slice(2)));\n`,
      { mode: 0o644 },
    );
  return dist;
}

/** `body`, run as if `opm` had been started from `entry`. */
async function asEntry<T>(entry: string, body: () => T | Promise<T>) {
  const [argv1, fromEnv] = [process.argv[1], process.env.OPM_OPMX];
  process.argv[1] = entry;
  delete process.env.OPM_OPMX;
  try {
    return await body();
  } finally {
    process.argv[1] = argv1!;
    if (fromEnv === undefined) delete process.env.OPM_OPMX;
    else process.env.OPM_OPMX = fromEnv;
  }
}

describe('the opmx a shim re-enters through', () => {
  it('is the file the opmx bin names, in a build', async () => {
    const dist = await build(['opmx.js', 'opmx-main.js']);
    expect(await asEntry(join(dist, 'main.js'), resolveOpmxPath)).toBe(
      join(dist, 'opmx-main.js'),
    );
  });

  it.each(['opmx-main.js', 'opmx.js', 'opmx.mjs'])(
    'is started with Node when it is a module without an execute bit (%s)',
    async (name) => {
      const dist = await build([name]);
      const project = await mkdtemp(join(tmpdir(), 'opm-shim-project-'));
      temps.push(project);
      const store = join(project, 'store');
      await mkdir(store);
      await writeFile(join(store, 'cli.js'), '');
      const [shim] = await asEntry(join(dist, 'main.js'), () =>
        writeBinShims({
          binDir: join(project, 'bin'),
          storeRoot: store,
          bins: [{ name: 'tool', path: 'cli.js' }],
        }),
      );
      expect(
        execFileSync(shim!.shim, ['--flag', 'value'], {
          encoding: 'utf8',
          env: { ...process.env, OPM_OPMX: '' },
        }),
      ).toBe(`${name} ["--","tool","--flag","value"]\n`);
    },
  );

  it('is handed the name after `--`, so no name reads as one of its options', async () => {
    const dist = await build(['opmx-main.js']);
    const project = await mkdtemp(join(tmpdir(), 'opm-shim-project-'));
    temps.push(project);
    const store = join(project, 'store');
    await mkdir(store);
    await writeFile(join(store, 'cli.js'), '');
    const [shim] = await asEntry(join(dist, 'main.js'), () =>
      writeBinShims({
        binDir: join(project, 'bin'),
        storeRoot: store,
        bins: [{ name: 'allow-network', path: 'cli.js' }],
      }),
    );
    expect(
      execFileSync(shim!.shim, ['--allow-network'], {
        encoding: 'utf8',
        env: { ...process.env, OPM_OPMX: '' },
      }),
    ).toBe('opmx-main.js ["--","allow-network","--allow-network"]\n');
  });
});

describe('a bin whose name starts with "-"', () => {
  it.each(['-x', '--allow-network', '--'])(
    'gets no shim (%s): it would read as an option',
    async (name) => {
      const project = await mkdtemp(join(tmpdir(), 'opm-shim-dash-'));
      temps.push(project);
      const store = join(project, 'store');
      await mkdir(store);
      await writeFile(join(store, 'cli.js'), '');
      await expect(
        writeBinShims({
          binDir: join(project, 'bin'),
          storeRoot: store,
          bins: [{ name, path: 'cli.js' }],
        }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^UNSAFE_/u) });
    },
  );
});
