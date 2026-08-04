import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { FixtureHttpTransport } from '@openpacker/adapter-core';
import {
  defaultHostEnvironment,
  evaluateEnvironmentMarker,
  nativeRange,
  resolveGraph,
  resolveRegistryArtifact,
  shouldFollowRequirement,
  solveGraph,
} from '../src/index.js';

/**
 * Transitive resolution across ecosystems that encode ranges differently.
 *
 * npm already worked end-to-end. PyPI was the gap: its requirements store the
 * constraint in `specifier`, marker-gated edges were dropped wholesale, and
 * there was no offline graph test that proved a multi-package Python closure.
 */

const encoder = new TextEncoder();
const fixtureDir = new URL('../../../fixtures/catalogs/pypi/', import.meta.url);

const demoProject = await readFile(new URL('project.json', fixtureDir));
const alphaProject = await readFile(new URL('alpha.json', fixtureDir));
const betaProject = await readFile(new URL('beta.json', fixtureDir));
const gammaProject = await readFile(new URL('gamma.json', fixtureDir));
const wheel = await readFile(
  new URL('demo_tool-1.0.0-py3-none-any.whl', fixtureDir),
);
const wheelSha = createHash('sha256').update(wheel).digest('hex');

/** Rewrite artifact URLs onto the pypi allowlist origin. */
function withAllowedArtifactOrigins(bytes: Uint8Array): Uint8Array {
  const rewritten = new TextDecoder()
    .decode(bytes)
    .replaceAll(
      'https://fixtures.openpacker.invalid/pypi/',
      'https://files.pythonhosted.org/packages/fixture/',
    );
  return encoder.encode(rewritten);
}

function pypiTransport(): FixtureHttpTransport {
  const fixtures = new Map<
    string,
    { status: number; headers: Record<string, string>; body: Uint8Array }
  >([
    [
      'https://fixtures.test/demo-tool/json',
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: withAllowedArtifactOrigins(demoProject),
      },
    ],
    [
      'https://fixtures.test/alpha/json',
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: alphaProject,
      },
    ],
    [
      'https://fixtures.test/beta/json',
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: betaProject,
      },
    ],
    [
      'https://fixtures.test/gamma/json',
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: gammaProject,
      },
    ],
  ]);

  // Artifact origins must be on the pypi allowlist (files.pythonhosted.org)
  // for resolveRegistryArtifact's origin check. demo-tool's shared fixture
  // still uses fixtures.openpacker.invalid in project.json (adapter tests);
  // map both prefixes so either document shape works offline.
  for (const name of [
    'demo_tool-1.0.0-py3-none-any.whl',
    'demo_tool-1.0.0.tar.gz',
    'demo_tool-1.0.0b1-py3-none-any.whl',
    'demo_tool-1.1.0-py3-none-any.whl',
    'alpha-1.0.0-py3-none-any.whl',
    'alpha-1.5.0-py3-none-any.whl',
    'beta-2.0.0-py3-none-any.whl',
    'beta-2.1.0-py3-none-any.whl',
    'gamma-1.2.3-py3-none-any.whl',
    'gamma-1.2.4-py3-none-any.whl',
  ]) {
    const body = {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      body: wheel,
    };
    fixtures.set(
      `https://files.pythonhosted.org/packages/fixture/${name}`,
      body,
    );
    fixtures.set(`https://fixtures.openpacker.invalid/pypi/${name}`, body);
  }

  return new FixtureHttpTransport(fixtures);
}

const previousRegistry = process.env.OPM_REGISTRY_PYPI;

function withPypiFixtures<T>(run: () => Promise<T>): Promise<T> {
  process.env.OPM_REGISTRY_PYPI = 'https://fixtures.test';
  return run().finally(() => {
    if (previousRegistry === undefined) delete process.env.OPM_REGISTRY_PYPI;
    else process.env.OPM_REGISTRY_PYPI = previousRegistry;
  });
}

const options = () => ({
  transport: pypiTransport(),
  now: () => '2026-08-04T00:00:00Z',
});

describe('nativeRange', () => {
  it('reads npm range and PyPI specifier, not only one field name', () => {
    expect(
      nativeRange({
        nativeSemantics: { data: { range: '^1.2.3' } },
      }),
    ).toBe('^1.2.3');
    expect(
      nativeRange({
        nativeSemantics: { data: { specifier: '>=1.0,<2' } },
      }),
    ).toBe('>=1.0,<2');
    expect(
      nativeRange({
        raw: 'alpha>=1.0',
      }),
    ).toBe('>=1.0');
  });
});

describe('environment markers', () => {
  const env = defaultHostEnvironment({
    pythonVersion: '3.12',
    sysPlatform: 'linux',
    osName: 'posix',
    platformSystem: 'Linux',
  });

  it('evaluates the common python_version and platform atoms', () => {
    expect(evaluateEnvironmentMarker('python_version >= "3.10"', env)).toBe(
      true,
    );
    expect(evaluateEnvironmentMarker('python_version < "3.10"', env)).toBe(
      false,
    );
    expect(evaluateEnvironmentMarker('sys_platform == "linux"', env)).toBe(
      true,
    );
    expect(
      evaluateEnvironmentMarker(
        'python_version >= "3.10" and sys_platform == "win32"',
        env,
      ),
    ).toBe(false);
  });

  it('follows marker-gated optional requirements only when true for the host', () => {
    const req = {
      kind: 'runtime',
      optional: true,
      expression: { purl: 'pkg:pypi/beta' },
      nativeSemantics: {
        data: {
          specifier: '>=2.0',
          marker: 'python_version >= "3.10"',
        },
      },
    };
    expect(shouldFollowRequirement(req, env).follow).toBe(true);
    expect(
      shouldFollowRequirement(req, {
        ...env,
        pythonVersion: '3.9',
      }).follow,
    ).toBe(false);
  });
});

describe('PyPI transitive resolution', () => {
  it('walks unconditional requires_dist with PEP 440 ranges applied', async () => {
    await withPypiFixtures(async () => {
      const graph = await resolveGraph({
        roots: [{ purl: 'pkg:pypi/demo-tool', range: '==1.0.0' }],
        options: options(),
        host: defaultHostEnvironment({ pythonVersion: '3.9' }),
      });

      const purls = graph.packages.map((pkg) => pkg.identity.exactPurl).sort();
      // Unconditional: alpha>=1.0, gamma~=1.2.3. beta is marker-gated for
      // python_version >= 3.10, so a 3.9 host must not pull it in.
      expect(purls).toEqual(
        expect.arrayContaining([
          'pkg:pypi/demo-tool@1.0.0',
          'pkg:pypi/alpha@1.5.0',
          'pkg:pypi/gamma@1.2.4',
        ]),
      );
      expect(purls.some((purl) => purl.startsWith('pkg:pypi/beta@'))).toBe(
        false,
      );
      // The walk keeps up to N newest candidates per package; both alphas
      // satisfy >=1.0 and are legal members of the universe. The solver
      // picks among them later.
      expect(purls).toContain('pkg:pypi/alpha@1.0.0');
    });
  });

  it('includes marker-gated deps when the host marker is true', async () => {
    await withPypiFixtures(async () => {
      const graph = await resolveGraph({
        roots: [{ purl: 'pkg:pypi/demo-tool', range: '==1.0.0' }],
        options: options(),
        host: defaultHostEnvironment({ pythonVersion: '3.12' }),
      });
      const purls = graph.packages.map((pkg) => pkg.identity.exactPurl);
      expect(purls.some((purl) => purl.startsWith('pkg:pypi/beta@'))).toBe(
        true,
      );
      // Newest beta satisfying >=2.0.
      expect(purls).toContain('pkg:pypi/beta@2.1.0');
    });
  });

  it('solves a multi-package Python closure through the PREX checker', async () => {
    await withPypiFixtures(async () => {
      const graph = await resolveGraph({
        roots: [{ purl: 'pkg:pypi/demo-tool', range: '==1.0.0' }],
        options: options(),
        host: defaultHostEnvironment({ pythonVersion: '3.12' }),
      });
      const solved = await solveGraph({
        graph,
        rootRequirements: [{ purl: 'pkg:pypi/demo-tool' }],
        evaluationTime: '2026-08-04T00:00:00Z',
      });
      expect(solved.proofValid).toBe(true);
      const selected = solved.selected
        .map((pkg) => pkg.identity.exactPurl)
        .sort();
      expect(selected).toEqual(
        expect.arrayContaining([
          'pkg:pypi/demo-tool@1.0.0',
          'pkg:pypi/alpha@1.5.0',
          'pkg:pypi/gamma@1.2.4',
          'pkg:pypi/beta@2.1.0',
        ]),
      );

      // Artifacts are fetchable and digest-verified for every selected node.
      for (const instance of solved.selected) {
        const exact = instance.identity.exactPurl!;
        const artifact = await resolveRegistryArtifact(
          'pypi',
          exact,
          options(),
        );
        expect(artifact.digest).toBe(`sha256:${wheelSha}`);
        expect(artifact.bytes.byteLength).toBe(wheel.byteLength);
      }
    });
  });
});

// Keep the encoder import used if TypeScript elides — fixtures already encode.
void encoder;
