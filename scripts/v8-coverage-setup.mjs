import { writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { join } from 'node:path';
import globalTeardown from './v8-coverage-teardown.mjs';

const directory = process.env.OPENPACKER_V8_COVERAGE;
if (!directory) throw new Error('OPENPACKER_V8_COVERAGE is required');

// Setup files re-run per test file. The profiler is process-wide, so one
// session must survive that, and the dump must wait until the worker exits.
const stateKey = Symbol.for('openpacker.v8Coverage');
const state = (globalThis[stateKey] ??= {
  session: null,
  flushed: false,
  registered: false,
});

if (!state.session) {
  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.startPreciseCoverage', {
    callCount: true,
    detailed: true,
  });
  state.session = session;
}

if (!state.registered) {
  const worker = globalThis.__vitest_worker__;
  if (!worker?.onCleanup)
    throw new Error('V8 coverage requires the Vitest worker teardown hook');
  worker.onCleanup(() => globalTeardown());
  state.registered = true;
}

export async function flushV8Coverage() {
  if (!state.session || state.flushed) return;
  state.flushed = true;
  const coverage = await state.session.post('Profiler.takePreciseCoverage');
  writeFileSync(
    join(directory, `coverage-${process.pid}.json`),
    JSON.stringify(coverage),
  );
  await state.session.post('Profiler.stopPreciseCoverage');
  state.session.disconnect();
}
