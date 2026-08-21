import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertWitShapedModule, hasResource } from '@openpacker/adapter-host';
import {
  configureDefaultAdapters,
  createDefaultAdapterRegistry,
  defaultAdapterModules,
} from './index.js';

describe('default adapters', () => {
  it('registers npm through cargo/oci/nix/host managers without core switches', async () => {
    const registry = createDefaultAdapterRegistry();
    const types = registry.purlTypes();
    for (const expected of [
      'npm',
      'cargo',
      'pypi',
      'nuget',
      'maven',
      'golang',
      'oci',
      'nix',
      'deb',
      'apt',
      'winget',
      'chocolatey',
    ])
      expect(types, expected).toContain(expected);

    const npm = await registry.definitionFor('npm');
    expect(hasResource(npm, 'prex.registry.artifact/1')).toBe(true);
    expect(hasResource(npm, 'prex.registry.install/1')).toBe(false);

    const nix = await registry.definitionFor('nix');
    expect(hasResource(nix, 'prex.registry.install/1')).toBe(true);
    expect(await registry.prefersHostInstall('nix')).toBe(true);

    const choco = await registry.definitionFor('chocolatey');
    expect(hasResource(choco, 'prex.registry.install/1')).toBe(true);

    const apt = await registry.packerFor('apt');
    expect(apt.providerId).toBe('standard-deb');
    expect(apt.purlType).toBe('deb');
    await expect(
      apt.plan(
        { project: { root: '/workspace', manifestPath: '/workspace/control' } },
        { strategy: 'standard' },
      ),
    ).resolves.toMatchObject({ purlType: 'deb', strategy: 'standard' });
  });

  it('every default module satisfies the WIT-shaped bridge contract', async () => {
    for (const module of defaultAdapterModules())
      await assertWitShapedModule(module);
  });

  it('configures the process-wide registry', () => {
    const registry = configureDefaultAdapters();
    expect(registry.moduleFor('npm').id).toContain('npm');
  });

  it('fails closed when requesting install on catalog-only npm', async () => {
    const registry = createDefaultAdapterRegistry();
    await expect(registry.installerFor('npm')).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
    });
  });

  it('fails closed when requesting search when not advertised', async () => {
    const registry = createDefaultAdapterRegistry();
    // cargo sparse does not advertise search in the synthetic definition
    const cargo = await registry.definitionFor('cargo');
    expect(hasResource(cargo, 'prex.registry.search/1')).toBe(false);
    await expect(
      registry.catalogFor('cargo', {}, ['prex.registry.search/1']),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });

  it('binds OCI requests to the operator-configured registry origin', async () => {
    const requests: string[] = [];
    const registry = createDefaultAdapterRegistry();
    const provider = await registry.catalogFor('oci', {
      endpoint: 'https://registry.example',
      fetch: (async (input: URL | string) => {
        requests.push(String(input));
        return new Response(JSON.stringify({ tags: ['1.0.0'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });
    await expect(
      provider.enumerate(
        'pkg:oci/demo?repository_url=registry.example/acme/demo',
      ),
    ).resolves.toHaveLength(1);
    await expect(
      provider.enumerate('pkg:oci/demo?repository_url=evil.example/acme/demo'),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_ENDPOINT' });
    expect(requests).toHaveLength(2);
    expect(new Set(requests)).toEqual(
      new Set(['https://registry.example/v2/acme/demo/tags/list']),
    );
  });

  it('allowlists both default OCI registries and drops the other on override', async () => {
    const registry = createDefaultAdapterRegistry();
    const tags = JSON.stringify({ tags: ['1.0.0'] });
    const fetchOk = (async () =>
      new Response(tags, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const defaultProvider = await registry.catalogFor('oci', {
      fetch: fetchOk,
    });
    await expect(
      defaultProvider.enumerate(
        'pkg:oci/jq?repository_url=ghcr.io/homebrew/core/jq',
      ),
    ).resolves.toHaveLength(1);
    await expect(
      defaultProvider.enumerate('pkg:oci/library/alpine'),
    ).resolves.toHaveLength(1);

    const previous = process.env.OPM_REGISTRY_OCI;
    process.env.OPM_REGISTRY_OCI = 'https://oci.internal.example';
    try {
      const override = await registry.catalogFor('oci', { fetch: fetchOk });
      await expect(
        override.enumerate(
          'pkg:oci/jq?repository_url=ghcr.io/homebrew/core/jq',
        ),
      ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_ENDPOINT' });
      await expect(
        override.enumerate(
          'pkg:oci/demo?repository_url=oci.internal.example/acme/demo',
        ),
      ).resolves.toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.OPM_REGISTRY_OCI;
      else process.env.OPM_REGISTRY_OCI = previous;
    }
  });

  it('drops the public npm CDN after an OPM_REGISTRY_NPM override', async () => {
    const previous = process.env.OPM_REGISTRY_NPM;
    process.env.OPM_REGISTRY_NPM = 'https://npm.internal.example';
    try {
      const requests: string[] = [];
      const tarball = new Uint8Array([1, 2, 3, 4]);
      const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
      const packument = {
        name: 'demo',
        versions: {
          '1.0.0': {
            name: 'demo',
            version: '1.0.0',
            dist: {
              tarball: 'https://registry.npmjs.org/demo/-/demo-1.0.0.tgz',
              integrity,
            },
          },
        },
      };
      const registry = createDefaultAdapterRegistry();
      const provider = await registry.catalogFor('npm', {
        fetch: (async (input: URL | string) => {
          const href = String(input);
          requests.push(href);
          if (href === 'https://npm.internal.example/demo')
            return new Response(JSON.stringify(packument), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          return new Response(tarball, { status: 200 });
        }) as typeof fetch,
      });
      await expect(
        provider.fetchArtifactRecord('pkg:npm/demo@1.0.0'),
      ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_ENDPOINT' });
      expect(requests).toContain('https://npm.internal.example/demo');
      expect(requests.some((url) => url.includes('registry.npmjs.org'))).toBe(
        false,
      );
    } finally {
      if (previous === undefined) delete process.env.OPM_REGISTRY_NPM;
      else process.env.OPM_REGISTRY_NPM = previous;
    }
  });

  it('advertises only resources each module can honor', async () => {
    const registry = createDefaultAdapterRegistry();
    const expected: Record<string, string[]> = {
      npm: [
        'prex.registry.package-metadata/1',
        'prex.registry.enumerate-versions/1',
        'prex.registry.artifact/1',
        'prex.registry.search/1',
      ],
      cargo: [
        'prex.registry.package-metadata/1',
        'prex.registry.enumerate-versions/1',
        'prex.registry.artifact/1',
        'prex.registry.dependency-graph/1',
        'prex.registry.package-build/2',
      ],
      oci: [
        'prex.registry.package-metadata/1',
        'prex.registry.enumerate-versions/1',
        'prex.registry.artifact/1',
        'prex.registry.package-build/2',
      ],
      // Install-only until catalog/environment exports are wired.
      nix: ['prex.registry.install/1', 'prex.registry.package-build/2'],
      deb: ['prex.registry.install/1', 'prex.registry.package-build/2'],
      winget: ['prex.registry.install/1', 'prex.registry.package-build/2'],
      chocolatey: ['prex.registry.install/1', 'prex.registry.package-build/2'],
    };
    const forbiddenOnHost: Record<string, string[]> = {
      nix: [
        'prex.registry.search/1',
        'prex.registry.package-metadata/1',
        'prex.registry.uninstall/1',
        'prex.registry.environment/1',
      ],
      deb: [
        'prex.registry.search/1',
        'prex.registry.package-metadata/1',
        'prex.registry.uninstall/1',
      ],
      winget: [
        'prex.registry.search/1',
        'prex.registry.package-metadata/1',
        'prex.registry.uninstall/1',
      ],
      chocolatey: [
        'prex.registry.search/1',
        'prex.registry.package-metadata/1',
        'prex.registry.uninstall/1',
      ],
    };
    for (const [purlType, resources] of Object.entries(expected)) {
      const definition = await registry.definitionFor(purlType);
      for (const type of resources)
        expect(hasResource(definition, type), `${purlType} ${type}`).toBe(true);
    }
    for (const [purlType, resources] of Object.entries(forbiddenOnHost)) {
      const definition = await registry.definitionFor(purlType);
      for (const type of resources)
        expect(
          hasResource(definition, type),
          `${purlType} must not lie ${type}`,
        ).toBe(false);
    }
  });

  it('maps a NuGet v3 service index into Registry Definition resources', async () => {
    const serviceIndex = {
      version: '3.0.0',
      resources: [
        {
          '@id': 'https://api.nuget.org/v3/registration5-gz-semver2/',
          '@type': 'RegistrationsBaseUrl/3.6.0',
        },
        {
          '@id': 'https://api.nuget.org/v3-flatcontainer/',
          '@type': 'PackageBaseAddress/3.0.0',
        },
        {
          '@id': 'https://azuresearch-usnc.nuget.org/query',
          '@type': 'SearchQueryService/3.5.0',
        },
      ],
    };
    const body = new TextEncoder().encode(JSON.stringify(serviceIndex));
    const registry = createDefaultAdapterRegistry();
    const definition = await registry.definitionFor('nuget', {
      offline: false,
      transport: {
        request: async () => ({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body,
          url: 'https://api.nuget.org/v3/index.json',
        }),
      },
    });
    expect(hasResource(definition, 'prex.registry.service-index/1')).toBe(true);
    expect(hasResource(definition, 'prex.registry.package-metadata/1')).toBe(
      true,
    );
    expect(hasResource(definition, 'prex.registry.artifact/1')).toBe(true);
    expect(hasResource(definition, 'prex.registry.search/1')).toBe(true);
    // Absent type remains unsupported even after a live index load.
    expect(hasResource(definition, 'prex.registry.install/1')).toBe(false);
  });
});
