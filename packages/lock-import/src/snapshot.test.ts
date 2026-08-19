import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { planLockCapture } from './index.js';

/**
 * Characterization snapshots for native lockfile import. They pin the whole
 * capture plan for a real fixture so any change in translation, ordering, or
 * semantic-loss reporting shows up as a deliberate, reviewable snapshot diff
 * (update with `vitest run -u`), never a silent drift.
 */
describe('lock-import capture plan snapshots', () => {
  configureDefaultAdapters();

  const fixture = (name: string) =>
    readFile(
      new URL(`../../../fixtures/locks/${name}`, import.meta.url),
      'utf8',
    );

  it('pins the npm package-lock capture plan', async () => {
    const plan = await planLockCapture(await fixture('npm/package-lock.json'));
    const summary = {
      format: plan.format,
      ecosystem: plan.ecosystem,
      packageCount: plan.packages.length,
      lockedExactPurls: [...plan.lockedExactPurls].sort(),
      semanticLossCodes: plan.semanticLoss.map((loss) => loss.code).sort(),
      sourceDigest: plan.sourceDigest,
    };
    expect(`${JSON.stringify(summary, null, 2)}\n`).toMatchFileSnapshot(
      '__snapshots__/npm-capture-plan.snap',
    );
  });

  it('pins the cargo lock capture plan', async () => {
    const plan = await planLockCapture(await fixture('cargo/Cargo.lock'));
    const summary = {
      format: plan.format,
      ecosystem: plan.ecosystem,
      packageCount: plan.packages.length,
      lockedExactPurls: [...plan.lockedExactPurls].sort(),
      semanticLossCodes: plan.semanticLoss.map((loss) => loss.code).sort(),
      sourceDigest: plan.sourceDigest,
    };
    expect(`${JSON.stringify(summary, null, 2)}\n`).toMatchFileSnapshot(
      '__snapshots__/cargo-capture-plan.snap',
    );
  });
});
