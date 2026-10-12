import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const workflow = pathToFileURL(
  join(resolve(import.meta.dirname, '../..'), 'scripts/demo-workflow.mjs'),
).href;

// The demo serves the wasm solver to a browser from a local HTTP server. A
// server that is still listening keeps a process alive after the error that
// ended the demo has been printed, so each case runs in a process of its own
// and must end by itself.
const program = `
  const { browserSolve } = await import(${JSON.stringify(workflow)});
  let closed = 0;
  const launch = process.argv[1] === 'start'
    ? async () => { throw new Error('no browser in this environment'); }
    : async () => ({
        newPage: async () => { throw new Error('page failed'); },
        close: async () => { closed += 1; },
      });
  try {
    await browserSolve({}, {}, launch);
  } catch (error) {
    console.log('rejected: ' + error.message + '; browsers closed: ' + closed);
  }
`;

function runCase(name) {
  return spawnSync(
    process.execPath,
    ['--input-type=module', '-e', program, name],
    { encoding: 'utf8', timeout: 30_000 },
  );
}

test('a browser that cannot start leaves no server keeping the process alive', () => {
  const result = runCase('start');
  assert.equal(result.error, undefined, 'the process had to be killed');
  assert.equal(result.signal, null, 'the process had to be killed');
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /rejected: no browser in this environment; browsers closed: 0/u,
  );
});

test('a browser that fails mid-run is closed, and the process ends', () => {
  const result = runCase('mid');
  assert.equal(result.error, undefined, 'the process had to be killed');
  assert.equal(result.signal, null, 'the process had to be killed');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rejected: page failed; browsers closed: 1/u);
});
