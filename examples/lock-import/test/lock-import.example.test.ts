import { describe, expect, it } from 'vitest';
import * as bindings from '@openpacker/embedded/wasm-node';
import {
  EXAMPLE_LOCK_FIXTURES,
  runAllLockImportExamples,
} from '../src/index.js';

describe('lock-import example', () => {
  it('imports every committed native lock fixture under native-capture-v1', async () => {
    const summaries = await runAllLockImportExamples(bindings);
    expect(summaries).toHaveLength(EXAMPLE_LOCK_FIXTURES.length);
    for (const summary of summaries) {
      expect(summary.profile).toBe('native-capture-v1');
      expect(summary.captureOnly).toBe(true);
      expect(summary.selectedExactPurls.length).toBeGreaterThan(0);
      expect(summary.solutionDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(summary.receiptDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    const ecosystems = summaries.map((item) => item.ecosystem).sort();
    expect(ecosystems).toEqual(
      ['cargo', 'golang', 'maven', 'npm', 'nuget', 'pypi'].sort(),
    );
  });
});
