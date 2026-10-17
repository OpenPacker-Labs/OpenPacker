import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PolicyInput } from '@openpacker/contracts';
import { resolveManifestToLock, type OpmManifest } from '../src/index.js';
import { NpmRegistryFixture } from './npm-registry-fixture.js';

/**
 * What `opm add` and `opm install` end with when the closure cannot be locked.
 * It is a list, written with line feeds: the reason, then a line for each
 * candidate the walk set aside. The CLI's writer keeps those line feeds
 * (`apps/opm/test/error-lines.test.ts` pins the writer with this shape).
 */
describe('a closure that cannot be locked', () => {
  it('is refused with the reason, then one indented line for each candidate set aside', async () => {
    const policy: PolicyInput = {
      allowYanked: false,
      allowQuarantined: false,
      semanticLossMaximum: 'warning',
      requiredEvidence: [],
    };
    const manifest: OpmManifest = {
      project: { name: 'closure', ecosystems: ['npm'] },
      packages: {
        app: { alias: 'app', purl: 'pkg:npm/needs-aix', version: '1.0.0' },
      },
      options: { offline: false, layout: 'opm' },
      policy,
    };
    const root = await mkdtemp(join(tmpdir(), 'opm-closure-'));
    try {
      const failure = await resolveManifestToLock({
        root,
        manifest,
        offline: false,
        registryOptions: {
          transport: new NpmRegistryFixture([
            {
              name: 'needs-aix',
              versions: {
                '1.0.0': { dependencies: { 'only-aix': '1.0.0' } },
              },
            },
            // A hard dependency that no host here runs on.
            { name: 'only-aix', versions: { '1.0.0': { os: ['aix'] } } },
          ]),
        },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ code: 'UNRESOLVABLE' });
      expect((failure as Error).message).toMatch(
        /^Cannot lock the dependency closure of pkg:npm\/needs-aix@1\.0\.0: no selection of releases satisfies every requirement: [^\n]*\nWhat the walk could not use:\n {2}- pkg:npm\/only-aix@1\.0\.0: does not run on this host \([^\n]*\) \(required by pkg:npm\/needs-aix@1\.0\.0\)\n {2}- pkg:npm\/only-aix: no candidate satisfying 1\.0\.0 can be installed here \(required by pkg:npm\/needs-aix@1\.0\.0\)$/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
