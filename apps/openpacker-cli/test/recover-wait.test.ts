import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectStep } from '@openpacker/opm-project';
import { runOpm } from '../src/opm.js';
import { capture } from './run-fixture.js';

/** One step at a time changes a project; `opm` says when it waits. */

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('a command while another step changes the project', () => {
  it('waits, says for whom, and runs once it has finished', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opm-recover-wait-'));
    temps.push(root);
    expect(
      await runOpm(['init', '--name', 'waiting'], capture().io, root),
    ).toBe(0);
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const held = projectStep(root, {}, async () => {
      entered();
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    await inside;
    const run = capture();
    const code = await runOpm(['sync', '--offline'], run.io, root);
    await held;
    expect(code, run.err).toBe(0);
    expect(run.err).toMatch(
      new RegExp(
        `^opm: waiting for process ${process.pid} on ${hostname()}, which is changing this project \\(\\.opm/step-[^)]+\\.lock\\)$`,
        'mu',
      ),
    );
  });
});
