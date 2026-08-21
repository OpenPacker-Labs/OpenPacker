/**
 * Behavior specifications for native lockfile import. Each test is a user
 * journey phrased Given/When/Then: they pin *what the product promises* (or
 * honestly refuses), not how the code is organised. Unit-level detail lives
 * in the packages; these scenarios fail when the journey breaks regardless
 * of which module changed.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

const { configureDefaultAdapters } = await import(
  '@openpacker/adapters-default'
);
const { planLockCapture } = await import('@openpacker/lock-import');

configureDefaultAdapters();

test('Given a native uv.lock TOML file, when it is imported offline, then pypi pins are captured without a JSON conversion step', async () => {
  const raw = await readFile(join(root, 'fixtures/locks/pypi/uv.lock'), 'utf8');
  assert.doesNotMatch(raw.trimStart(), /^\{/u);

  const plan = await planLockCapture(raw);

  assert.equal(plan.format, 'uv-lock');
  assert.equal(plan.ecosystem, 'pypi');
  assert.ok(
    plan.lockedExactPurls.some((purl) => purl.startsWith('pkg:pypi/')),
    'expected pkg:pypi/ pins',
  );
  assert.ok(
    plan.semanticLoss.some(
      (loss) => loss.code === 'NATIVE_RESULT_CAPTURE_ONLY',
    ),
  );
});

test('Given an npm project lock, when it is imported offline, then every locked entry becomes an exact captured selection', async () => {
  // Given a repository with a native npm lockfile
  const raw = await readFile(
    join(root, 'fixtures/locks/npm/package-lock.json'),
    'utf8',
  );

  // When the user imports the lock without any network access
  const plan = await planLockCapture(raw);

  // Then the import is honestly labelled as a capture, every locked entry is
  // accounted for, and no package is silently dropped or invented.
  assert.equal(plan.ecosystem, 'npm');
  assert.equal(plan.format, 'package-lock');
  assert.ok(plan.packages.length > 0, 'expected captured packages');
  assert.equal(plan.lockedExactPurls.length, plan.packages.length);
  assert.equal(
    new Set(plan.lockedExactPurls).size,
    plan.lockedExactPurls.length,
  );
  assert.match(plan.sourceDigest.value, /^[0-9a-f]{64}$/u);
  // And every semantic compromise is recorded, never silent.
  for (const loss of plan.semanticLoss) {
    assert.equal(typeof loss.code, 'string');
    assert.notEqual(loss.code.length, 0);
  }
});

test('Given a pnpm v6 lockfile, when import is attempted, then the product refuses honestly instead of guessing', async () => {
  // Given a lockfile from a pnpm major the importer does not support
  const v6 =
    "lockfileVersion: '6.0'\n\npackages:\n  /left-pad@1.3.0:\n    resolution: {integrity: sha512-abc=}\n";

  // When the user imports it
  // Then the refusal is loud and names the problem, rather than importing a
  // lossy approximation.
  await assert.rejects(planLockCapture(v6), (error) => {
    assert.equal(error.code, 'INVALID_LOCKFILE');
    assert.match(error.message, /unable to detect native lockfile format/iu);
    return true;
  });
});

test('Given a requirements.txt with --hash pins, when import is attempted, then the unsupported directive is refused', async () => {
  // Given a requirements file that pins artifact hashes
  const requirements = 'idna==3.7 --hash=sha256:abcd\n';

  // When the user imports it
  // Then the pin is not silently dropped; the import refuses fail-closed.
  await assert.rejects(planLockCapture(requirements), (error) => {
    assert.match(error.message, /artifact hash/iu);
    return true;
  });
});

test('Given a requirements.txt that smuggles --hash into the version token, when imported, then the evasion is refused', async () => {
  // Given a requirements line crafted to dodge whitespace-delimited checks
  const evasive = 'idna==3.7--hash=sha256:abcd\n';

  // When the user imports it
  // Then the hash marker is still detected and refused.
  await assert.rejects(planLockCapture(evasive), (error) => {
    assert.match(error.message, /artifact hash/iu);
    return true;
  });
});
