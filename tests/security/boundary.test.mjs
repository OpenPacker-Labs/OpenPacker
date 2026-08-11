import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import test from 'node:test';
import { join, relative, resolve } from 'node:path';
import { inspectArchive, validateArchivePath } from '@openpacker/materializer';

const root = resolve(import.meta.dirname, '../..');

function walk(directory) {
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (['dist', 'node_modules', '.turbo'].includes(name)) continue;
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

test('production OpenPacker code has no Epoch or ATProto imports', () => {
  const roots = ['apps', 'crates', 'packages', 'integrations']
    .map((directory) => join(root, directory))
    .filter((directory) => {
      try {
        return statSync(directory).isDirectory();
      } catch {
        return false;
      }
    });
  const forbidden =
    /(?:from\s+|import\s*\(|require\s*\()\s*["'](?:@epoch\/|epoch(?:[\/@"'])|@atproto\/|atproto(?:[\/@"']))/u;
  const violations = roots
    .flatMap(walk)
    .filter((path) => /\.(?:[cm]?[jt]s|rs|lua)$/u.test(path))
    .filter((path) => forbidden.test(readFileSync(path, 'utf8')));
  assert.deepEqual(
    violations.map((path) => relative(root, path)),
    [],
  );
});

function tar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const data = new TextEncoder().encode(entry.data ?? '');
    const header = new Uint8Array(512);
    header.set(new TextEncoder().encode(entry.name), 0);
    const octal = (value, length) =>
      new TextEncoder().encode(
        value.toString(8).padStart(length - 1, '0') + '\0',
      );
    header.set(octal(entry.mode ?? 0o644, 8), 100);
    header.set(octal(0, 8), 108);
    header.set(octal(0, 8), 116);
    header.set(octal(data.byteLength, 12), 124);
    header.set(octal(0, 12), 136);
    header.fill(32, 148, 156);
    header[156] = (entry.type ?? '0').charCodeAt(0);
    header.set(new TextEncoder().encode('ustar\0'), 257);
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    header.set(
      new TextEncoder().encode(checksum.toString(8).padStart(6, '0') + '\0 '),
      148,
    );
    blocks.push(
      header,
      data,
      new Uint8Array((512 - (data.byteLength % 512)) % 512),
    );
  }
  blocks.push(new Uint8Array(1024));
  const bytes = new Uint8Array(
    blocks.reduce((sum, block) => sum + block.byteLength, 0),
  );
  let offset = 0;
  for (const block of blocks) {
    bytes.set(block, offset);
    offset += block.byteLength;
  }
  return bytes;
}

test('artifact exploit corpus executes every rejection vector', async () => {
  const vectors = JSON.parse(
    readFileSync(
      join(root, 'fixtures/artifacts/security/archive-cases.json'),
      'utf8',
    ),
  );
  const tarTypes = {
    symlink: '2',
    hardlink: '1',
    device: '3',
    fifo: '6',
  };
  const rejectionCodes = {
    symlink: 'SYMLINK_REJECTED',
    hardlink: 'HARDLINK_REJECTED',
    'special-device': 'SPECIAL_FILE_REJECTED',
    fifo: 'SPECIAL_FILE_REJECTED',
    'case-collision': 'CASE_COLLISION',
    duplicate: 'DUPLICATE_PATH',
  };
  const executed = new Set();
  for (const vector of vectors.mustReject) {
    if (vector.paths) {
      const archive = tar(
        vector.paths.map((name) => ({ name, data: 'payload' })),
      );
      await assert.rejects(
        inspectArchive(archive, 'tar'),
        { code: rejectionCodes[vector.id] },
        `${vector.id} was accepted`,
      );
      executed.add(vector.id);
    } else if (vector.entryType === 'file') {
      // setuid/setgid bits must never survive into materialized modes.
      const archive = tar([
        { name: vector.path, data: 'payload', mode: parseInt(vector.mode, 8) },
      ]);
      const entries = await inspectArchive(archive, 'tar');
      assert.equal(entries.length, 1);
      assert.equal(
        entries[0].mode & 0o7000,
        0,
        `${vector.id} preserved setuid/setgid/sticky bits`,
      );
      executed.add(vector.id);
    } else if (vector.entryType) {
      const archive = tar([
        { name: vector.path, type: tarTypes[vector.entryType] },
      ]);
      await assert.rejects(
        inspectArchive(archive, 'tar'),
        { code: rejectionCodes[vector.id] },
        `${vector.id} was accepted`,
      );
      executed.add(vector.id);
    } else {
      assert.throws(
        () => validateArchivePath(vector.path),
        undefined,
        `${vector.id} was accepted`,
      );
      executed.add(vector.id);
    }
  }

  assert.deepEqual(
    new Set(vectors.mustReject.map(({ id }) => id)),
    new Set([
      'parent-traversal',
      'posix-absolute',
      'windows-drive',
      'windows-unc',
      'symlink',
      'hardlink',
      'special-device',
      'fifo',
      'unsafe-permission',
      'case-collision',
      'duplicate',
    ]),
  );
  assert.equal(executed.size, vectors.mustReject.length);
  assert.deepEqual(Object.keys(vectors.bombPolicy).sort(), [
    'maximumCompressedBytes',
    'maximumCompressionRatio',
    'maximumDepth',
    'maximumExpandedBytes',
    'maximumFiles',
    'maximumPathBytes',
  ]);
});

test('mandatory scripts cannot execute package lifecycle hooks', () => {
  const packageJson = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  );
  const commands = [
    'demo',
    'verify',
    'test',
    'test:conformance',
    'test:security',
    'test:integration',
    'test:e2e',
  ];
  for (const command of commands) {
    assert.equal(
      typeof packageJson.scripts?.[command],
      'string',
      `missing root ${command} script`,
    );
    assert.doesNotMatch(
      packageJson.scripts[command],
      /(?:npm|pnpm|yarn)\s+(?:install|rebuild)(?:\s|$)/u,
      `${command} may execute dependency lifecycle scripts`,
    );
  }
});

test('sandbox package exists and defaults to fail-closed', async () => {
  const sandbox = await import('@openpacker/sandbox');
  assert.equal(sandbox.DEFAULT_SANDBOX_POLICY.mode, 'fail-closed');
  assert.equal(sandbox.DEFAULT_SANDBOX_POLICY.required, true);
  assert.equal(sandbox.DEFAULT_SANDBOX_POLICY.prefer, 'auto');
  assert.equal(typeof sandbox.runInSandbox, 'function');
  assert.equal(typeof sandbox.runHostInstaller, 'function');
  assert.equal(typeof sandbox.assertSafeJailPath, 'function');
  assert.equal(sandbox.SANDBOX_LOSS.UNAVAILABLE, 'SANDBOX_UNAVAILABLE');
  assert.equal(
    sandbox.SANDBOX_LOSS.SYSTEM_NOT_SANDBOXED,
    'SYSTEM_INSTALL_NOT_SANDBOXED',
  );
  // Credential dirs/files must be listed for native mask overlays (not all of /home —
  // toolchains often live under the user home).
  const masks = sandbox.sensitiveMaskDirectories();
  assert.ok(masks.some((p) => p.endsWith('/.ssh') || p.includes('/.ssh')));
  assert.ok(sandbox.sensitiveMaskFiles().includes('/etc/shadow'));
});
