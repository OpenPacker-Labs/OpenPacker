import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');

// A local cargo runs the toolchain rust-toolchain.toml names; without the file
// it runs the rustup default, and a newer clippy fails `npm run check:rust` on
// code the pinned one accepts. The pin is the one every workflow installs.
test('cargo runs the Rust every workflow installs', () => {
  const pin = /^channel = "([^"]+)"$/mu.exec(
    readFileSync(join(root, 'rust-toolchain.toml'), 'utf8'),
  )?.[1];
  assert.ok(pin, 'rust-toolchain.toml names a channel');

  const workflows = join(root, '.github/workflows');
  const installed = readdirSync(workflows)
    .filter((name) => name.endsWith('.yml'))
    .flatMap((name) =>
      [
        ...readFileSync(join(workflows, name), 'utf8').matchAll(
          /dtolnay\/rust-toolchain@(\S+)/gu,
        ),
      ].map((match) => `${name}: ${match[1]}`),
    );
  assert.ok(installed.length > 0, 'a workflow installs Rust');
  for (const entry of installed) assert.ok(entry.endsWith(`: ${pin}`), entry);

  const rustVersion = /^rust-version = "([^"]+)"$/mu.exec(
    readFileSync(join(root, 'Cargo.toml'), 'utf8'),
  )?.[1];
  assert.ok(rustVersion && pin.startsWith(`${rustVersion}.`), rustVersion);
});
