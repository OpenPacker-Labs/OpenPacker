import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');

function rustActionPin() {
  try {
    const pins = JSON.parse(
      readFileSync(join(root, '.github/action-pins.json'), 'utf8'),
    );
    const entry = pins['dtolnay/rust-toolchain@1.88.0'];
    if (entry?.sha && entry.comment) return entry;
  } catch {
    /* action-pins lands in the SHA-pin PR */
  }
  return { sha: null, comment: '1.88.0' };
}

function rustToolchainRefs() {
  const workflows = join(root, '.github/workflows');
  return readdirSync(workflows)
    .filter((name) => name.endsWith('.yml'))
    .flatMap((name) => {
      const text = readFileSync(join(workflows, name), 'utf8');
      return [...text.matchAll(/dtolnay\/rust-toolchain@(\S+)/gu)].map(
        (match) => ({ file: name, ref: match[1] }),
      );
    });
}

// A local cargo runs the toolchain rust-toolchain.toml names; without the file
// it runs the rustup default, and a newer clippy fails `npm run check:rust` on
// code the pinned one accepts. The pin is the one every workflow installs.
test('cargo runs the Rust every workflow installs', () => {
  const rustAction = rustActionPin();
  const pin = /^channel = "([^"]+)"$/mu.exec(
    readFileSync(join(root, 'rust-toolchain.toml'), 'utf8'),
  )?.[1];
  assert.ok(pin, 'rust-toolchain.toml names a channel');
  assert.equal(rustAction.comment, pin);

  const installed = rustToolchainRefs();
  assert.ok(installed.length > 0, 'a workflow installs Rust');
  for (const { file, ref } of installed) {
    const [shaOrTag, comment] = ref.split(/\s+#\s+/u);
    if (rustAction.sha) {
      assert.ok(
        shaOrTag === rustAction.sha || shaOrTag === rustAction.comment,
        `${file}: ${ref}`,
      );
      if (comment !== undefined)
        assert.equal(comment, rustAction.comment, `${file}: ${ref}`);
    } else assert.equal(shaOrTag, rustAction.comment, `${file}: ${ref}`);
  }

  const rustVersion = /^rust-version = "([^"]+)"$/mu.exec(
    readFileSync(join(root, 'Cargo.toml'), 'utf8'),
  )?.[1];
  assert.ok(rustVersion && pin.startsWith(`${rustVersion}.`), rustVersion);
});

// On a fresh machine rustup installs the pinned toolchain with what the file
// lists and nothing more. Without the wasm target `build:wasm` is skipped (or
// refused under OPENPACKER_REQUIRE_WASM), and without clippy and rustfmt
// `check:rust` cannot run, so the file lists every target and component a
// workflow installs beside the toolchain.
test('the pinned toolchain comes with every target and component a workflow installs', () => {
  const toml = readFileSync(join(root, 'rust-toolchain.toml'), 'utf8');
  const listed = (key) =>
    new Set(
      [
        ...(
          new RegExp(`^${key} = \\[([^\\]]*)\\]$`, 'mu').exec(toml)?.[1] ?? ''
        ).matchAll(/"([^"]+)"/gu),
      ].map((match) => match[1]),
    );
  const pinned = {
    targets: listed('targets'),
    components: listed('components'),
  };

  const workflows = join(root, '.github/workflows');
  const wanted = { targets: new Set(), components: new Set() };
  for (const name of readdirSync(workflows).filter((file) =>
    file.endsWith('.yml'),
  ))
    for (const step of readFileSync(join(workflows, name), 'utf8').matchAll(
      /dtolnay\/rust-toolchain@\S+(?:\s+#\s+[^\n]+)?\n\s+with:\n((?:\s+[a-z-]+: .*\n)+)/gu,
    ))
      for (const [, key, value] of step[1].matchAll(
        /^\s+(targets|components): (.*)$/gmu,
      ))
        for (const item of value.split(','))
          wanted[key].add(`${item.trim()} (${name})`);

  assert.ok(wanted.targets.size > 0, 'a workflow installs a target');
  for (const key of ['targets', 'components'])
    for (const entry of wanted[key])
      assert.ok(
        pinned[key].has(entry.slice(0, entry.indexOf(' ('))),
        `rust-toolchain.toml ${key} lacks ${entry}`,
      );
});
