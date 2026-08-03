import { writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const directory = process.env.OPENPACKER_V8_COVERAGE;
if (!directory) throw new Error('OPENPACKER_V8_COVERAGE is required');

const session = new Session();
session.connect();
await session.post('Profiler.enable');
await session.post('Profiler.startPreciseCoverage', {
  callCount: true,
  detailed: true,
});

afterAll(async () => {
  const coverage = await session.post('Profiler.takePreciseCoverage');
  const worker = process.env.VITEST_WORKER_ID ?? '0';
  writeFileSync(
    join(directory, `coverage-${process.pid}-${worker}-${Date.now()}.json`),
    JSON.stringify(coverage),
  );
  await session.post('Profiler.stopPreciseCoverage');
  session.disconnect();
});
