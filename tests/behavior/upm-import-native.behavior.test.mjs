/**
 * Behavior specifications for `opm import --native`. Given/When/Then over the
 * public CLI: native requirements become opm.toml once, and later sync does
 * not re-read the native manifest.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runOpm } = await import('@openpacker/opm');

function capture() {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: { write: (s) => ((out += s), true) },
      stderr: { write: (s) => ((err += s), true) },
    },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

test('Given a native npm manifest, when import --native runs, then opm.toml lists those requirements and sync does not re-import them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'upm-import-native-'));
  try {
    await writeFile(
      join(root, 'package.json'),
      `${JSON.stringify(
        {
          name: 'native-app',
          version: '0.0.0',
          dependencies: { 'left-pad': '1.3.0' },
        },
        undefined,
        2,
      )}\n`,
    );

    const imported = capture();
    const code = await runOpm(['import', '--native'], imported.io, root);
    assert.equal(code, 0, imported.err);
    assert.match(imported.out, /Imported 1 requirement/);
    assert.match(imported.out, /left-pad/);
    assert.match(imported.out, /pkg:npm\/left-pad/);

    const toml = await readFile(join(root, 'opm.toml'), 'utf8');
    assert.match(toml, /\[packages\.left-pad\]/);
    assert.match(toml, /purl = "pkg:npm\/left-pad"/);
    assert.match(toml, /version = "1\.3\.0"/);

    const emptied = toml.replace(
      /\[packages\.left-pad\][\s\S]*?(?=\n\[|\n*$)/u,
      '',
    );
    await writeFile(join(root, 'opm.toml'), emptied);

    const synced = capture();
    const syncCode = await runOpm(['sync', '--offline'], synced.io, root);
    assert.equal(syncCode, 0, synced.err);

    const after = await readFile(join(root, 'opm.toml'), 'utf8');
    assert.doesNotMatch(after, /\[packages\.left-pad\]/);
    assert.doesNotMatch(after, /left-pad/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
