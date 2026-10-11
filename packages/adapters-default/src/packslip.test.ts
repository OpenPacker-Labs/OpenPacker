import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasResource } from '@openpacker/adapter-host';
import {
  FakeWeb,
  buildRelease,
  fakeFetch,
  generateTestKey,
  githubWorld,
  type TestKey,
} from '@openpacker/packslip-testkit';
import { createDefaultAdapterRegistry } from './index.js';

const PROJECT = 'github.com/acme/tool';
const BASE = 'pkg:packslip/github.com/acme/tool';
const NOW = '2026-10-11T00:00:00.000Z';

let key: TestKey;
let web: FakeWeb;
const saved = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  key = generateTestKey();
  web = new FakeWeb();
  const built = buildRelease({
    project: PROJECT,
    version: '1.2.3',
    key,
    baseUrl: 'https://github.com/acme/tool/releases/download/v1.2.3',
    // No os or arch: the release fits whatever machine runs this test.
    artifacts: [{}],
  });
  githubWorld(web, {
    repo: 'acme/tool',
    releases: [{ tag: 'v1.2.3', release: built }],
  });
});

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
});

const settings = () => ({
  trust: {
    [PROJECT]: { public_key: key.publicKeyFile, allow_unlogged: true },
  },
});

describe('the packslip adapter in the default set', () => {
  it('owns the packslip PURL type and advertises only what it can do', async () => {
    const registry = createDefaultAdapterRegistry();
    expect(registry.purlTypes()).toContain('packslip');
    const definition = await registry.definitionFor('packslip');
    for (const type of [
      'prex.registry.package-metadata/1',
      'prex.registry.enumerate-versions/1',
      'prex.registry.artifact/1',
    ])
      expect(hasResource(definition, type), type).toBe(true);
    // Nothing is installed by a host tool, and there is nothing to search.
    for (const type of [
      'prex.registry.install/1',
      'prex.registry.search/1',
      'prex.registry.uninstall/1',
    ])
      expect(hasResource(definition, type), type).toBe(false);
    expect(definition.features?.signedMetadata).toBe(true);
    expect(await registry.prefersHostInstall('packslip')).toBe(false);
  });

  it('resolves, verifies and returns a release through the registry', async () => {
    const provider = await createDefaultAdapterRegistry().catalogFor(
      'packslip',
      {
        fetch: fakeFetch(web),
        now: () => NOW,
        settings: settings(),
      },
      ['prex.registry.package-metadata/1', 'prex.registry.artifact/1'],
    );
    expect(await provider.enumerate(BASE)).toEqual([`${BASE}@1.2.3`]);
    const inspection = await provider.inspect(`${BASE}@1.2.3`);
    expect(inspection.attestation).toMatchObject({
      kind: 'packslip',
      signerIdentity: key.keyId,
    });
    const record = await provider.fetchArtifactRecord(`${BASE}@1.2.3`);
    expect(record.rawBody.byteLength).toBeGreaterThan(0);
  });

  it('refuses a key-signed release when the project trusted no key', async () => {
    const provider = await createDefaultAdapterRegistry().catalogFor(
      'packslip',
      { fetch: fakeFetch(web), now: () => NOW },
    );
    await expect(provider.inspect(`${BASE}@1.2.3`)).rejects.toMatchObject({
      code: 'SIGNATURE_VERIFICATION_FAILED',
    });
  });

  it('refuses a misspelled setting before any request is made', async () => {
    const requests: string[] = [];
    const watched = fakeFetch(web);
    await expect(
      createDefaultAdapterRegistry().catalogFor('packslip', {
        fetch: (async (input, init) => {
          requests.push(String(input));
          return watched(input, init);
        }) as typeof fetch,
        now: () => NOW,
        settings: { trust: { [PROJECT]: { pins: ['x'] } } },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_PACKSLIP_INPUT',
      message: expect.stringContaining('unknown key "pins"'),
    });
    expect(requests).toEqual([]);
  });

  it('refuses a token variable name that is not a name, without repeating it', async () => {
    setEnv('OPM_PACKSLIP_GITHUB_TOKEN_ENV', 'github_pat_11AB-secret-value');
    const error = await createDefaultAdapterRegistry()
      .catalogFor('packslip', {
        fetch: fakeFetch(web),
        now: () => NOW,
        settings: settings(),
      })
      .then(
        () => undefined,
        (caught: Error) => caught,
      );
    expect(error).toMatchObject({ code: 'INVALID_PACKSLIP_INPUT' });
    expect(String(error)).not.toContain('secret-value');
  });

  it('reports an unreadable trusted root instead of falling back to the built-in one', async () => {
    setEnv('OPM_PACKSLIP_TRUSTED_ROOT', '/nonexistent/trusted_root.json');
    const registry = createDefaultAdapterRegistry();
    await expect(
      registry.catalogFor('packslip', {
        fetch: fakeFetch(web),
        now: () => NOW,
        settings: settings(),
      }),
    ).rejects.toThrow(/OPM_PACKSLIP_TRUSTED_ROOT could not be read/u);
  });
});
