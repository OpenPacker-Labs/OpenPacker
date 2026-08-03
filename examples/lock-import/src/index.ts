import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { canonicalDigest, formatDigest } from '@openpacker/canonical';
import { createEmbeddedResolver } from '@openpacker/embedded';
import type { EmbeddedBindings } from '@openpacker/embedded';
import {
  completeLockImport,
  planNativeLockImport,
  type LockImportResult,
} from '@openpacker/lock-import';

export interface LockImportExampleSummary {
  ecosystem: string;
  source: string;
  selectedExactPurls: string[];
  solutionDigest: string;
  receiptDigest: string;
  profile: string;
  captureOnly: boolean;
}

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/locks',
);

/** Committed freeze formats exercised by the offline example. */
export const EXAMPLE_LOCK_FIXTURES = [
  { ecosystem: 'npm', relative: 'npm/package-lock.json' },
  { ecosystem: 'cargo', relative: 'cargo/Cargo.lock' },
  { ecosystem: 'nuget', relative: 'nuget/project.assets.json' },
  { ecosystem: 'pypi', relative: 'pypi/uv.lock.json' },
  { ecosystem: 'golang', relative: 'golang/go.sum' },
  { ecosystem: 'maven', relative: 'maven/gradle.lockfile' },
] as const;

/**
 * Import one native lockfile offline: plan capture → pure solve/check → lockfile.
 * Does not contact registries or openpackerd.
 */
export async function importNativeLockExample(
  bindings: EmbeddedBindings,
  absoluteLockPath: string,
  meta: { providerId?: string; version?: string } = {},
): Promise<LockImportResult> {
  const raw = await readFile(absoluteLockPath, 'utf8');
  const plan = await planNativeLockImport(raw);
  const resolver = createEmbeddedResolver(bindings);
  return completeLockImport(plan, resolver, {
    providerId: meta.providerId ?? 'org.openpacker.example.lock-import',
    version: meta.version ?? '0.1.0',
    resolverBuildDigest: await canonicalDigest({
      implementation: 'example-lock-import',
      version: meta.version ?? '0.1.0',
    }),
  });
}

/** Run every committed lock fixture and return digest summaries. */
export async function runAllLockImportExamples(
  bindings: EmbeddedBindings,
): Promise<LockImportExampleSummary[]> {
  const summaries: LockImportExampleSummary[] = [];
  for (const fixture of EXAMPLE_LOCK_FIXTURES) {
    const source = join(fixtureRoot, fixture.relative);
    const result = await importNativeLockExample(bindings, source);
    const profile = result.solveResponse.normalizedRequest.semantics.profile;
    if (profile !== 'native-capture-v1')
      throw new Error(
        `${fixture.ecosystem}: expected native-capture-v1, got ${profile}`,
      );
    const captureOnly = result.semanticLoss.some(
      (loss) => loss.code === 'NATIVE_RESULT_CAPTURE_ONLY',
    );
    if (!captureOnly)
      throw new Error(
        `${fixture.ecosystem}: missing NATIVE_RESULT_CAPTURE_ONLY semantic loss`,
      );
    summaries.push({
      ecosystem: fixture.ecosystem,
      source: `fixtures/locks/${fixture.relative}`,
      selectedExactPurls: result.lockfile.selectedExactPurls,
      solutionDigest: formatDigest(
        result.solveResponse.solution.solutionDigest,
      ),
      receiptDigest: formatDigest(result.lockfile.receiptDigest),
      profile,
      captureOnly,
    });
  }
  return summaries;
}
