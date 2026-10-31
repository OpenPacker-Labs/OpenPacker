import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  CONCURRENCY_VARIABLE,
  turboArguments,
  turboConcurrency,
} from '../../scripts/turbo-run.mjs';

const root = resolve(import.meta.dirname, '../..');

test('turbo runs one task at a time unless the variable says otherwise', () => {
  assert.equal(turboConcurrency({}), '1');
  assert.equal(turboConcurrency({ [CONCURRENCY_VARIABLE]: '' }), '1');
  for (const value of ['1', '4', '9999', '1%', '50%', '100%'])
    assert.equal(turboConcurrency({ [CONCURRENCY_VARIABLE]: value }), value);
});

test('a concurrency turbo would not take, or would take as something else, is refused', () => {
  for (const value of [
    '0',
    '-1',
    '1.5',
    '04',
    '10000',
    '0%',
    '101%',
    'all',
    ' 2',
  ])
    assert.throws(
      () => turboConcurrency({ [CONCURRENCY_VARIABLE]: value }),
      new RegExp(CONCURRENCY_VARIABLE, 'u'),
      value,
    );
});

test('the task and its options go to turbo run, with the concurrency last', () => {
  assert.deepEqual(turboArguments(['test'], {}), [
    'run',
    'test',
    '--concurrency=1',
  ]);
  assert.deepEqual(
    turboArguments(['check:contracts', '--force'], {
      [CONCURRENCY_VARIABLE]: '3',
    }),
    ['run', 'check:contracts', '--force', '--concurrency=3'],
  );
  assert.throws(() => turboArguments([], {}), /usage/u);
  assert.throws(
    () => turboArguments(['test', '--concurrency=10'], {}),
    new RegExp(CONCURRENCY_VARIABLE, 'u'),
  );
});

test('npm test and the contract checks run turbo through it', () => {
  const { scripts } = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  );
  for (const task of ['test', 'check:contracts', 'check:generated'])
    assert.ok(
      scripts[task].startsWith(`node scripts/turbo-run.mjs ${task}`),
      `${task}: ${scripts[task]}`,
    );
  for (const [name, command] of Object.entries(scripts))
    assert.ok(!command.includes('--concurrency'), `${name}: ${command}`);
});
