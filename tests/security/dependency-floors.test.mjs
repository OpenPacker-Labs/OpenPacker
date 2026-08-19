import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const atLeast = (actual = '', minimum) => {
  const left = actual.split('.').map(Number);
  const right = minimum.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
};

test('committed dependency fixtures stay above patched security floors', async () => {
  const lock = JSON.parse(
    await readFile(new URL('package-lock.json', root), 'utf8'),
  );
  for (const [name, minimum] of [
    ['ajv', '8.18.0'],
    ['nanoid', '3.3.18'],
    ['yaml', '2.8.3'],
  ])
    assert.equal(
      atLeast(lock.packages[`node_modules/${name}`].version, minimum),
      true,
      `${name} must be at least ${minimum}`,
    );

  const requirements = await readFile(
    new URL('fixtures/locks/pypi/requirements.txt', root),
    'utf8',
  );
  const pins = new Map(
    [...requirements.matchAll(/^([a-z0-9-]+)==([0-9.]+)$/gmu)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  for (const [name, minimum] of [
    ['idna', '3.15'],
    ['requests', '2.33.0'],
    ['urllib3', '2.7.0'],
  ])
    assert.equal(
      atLeast(pins.get(name), minimum),
      true,
      `${name} must be at least ${minimum}`,
    );

  const poetry = await readFile(
    new URL('fixtures/locks/poetry/poetry.lock', root),
    'utf8',
  );
  assert.match(poetry, /name = "requests"\nversion = "2\.33\.0"/u);
});
