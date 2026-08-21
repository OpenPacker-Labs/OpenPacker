import { canonicalDigest, canonicalBytes } from '@openpacker/canonical';
import type { JsonValue } from '@openpacker/contracts';
import {
  header,
  json,
  parsePurl,
  ProviderError,
  semanticLoss,
  type Clock,
  type EnrichmentProvider,
  type EnrichmentResult,
  type HttpTransport,
  type ProviderCapabilities,
  type ProviderRecord,
} from '@openpacker/adapter-core';

const systems = { npm: 'NPM', cargo: 'CARGO', nuget: 'NUGET' } as const;

export interface DepsDevVersion {
  versionKey?: { system: string; name: string; version: string };
  publishedAt?: string;
  isDefault?: boolean;
  licenses?: string[];
  advisoryKeys?: { id: string }[];
  links?: { label: string; url: string }[];
  [key: string]: unknown;
}

export interface DepsDevDependencies {
  nodes?: unknown[];
  edges?: unknown[];
  [key: string]: unknown;
}

export class DepsDevProvider implements EnrichmentProvider {
  readonly providerId = 'deps-dev';
  readonly capabilities: ProviderCapabilities = {
    operations: ['enrich'],
    purlTypes: ['npm', 'cargo', 'nuget'],
    qualifierSupport: 'partial',
    targetSpecificSemantics: false,
    offlineReplay: true,
    extensions: {
      'openpacker.dev/capability-gaps': [
        'purl-qualifiers',
        'target-specific-dependencies',
        'native-feature-semantics',
      ],
      'openpacker.dev/api': 'deps.dev-v3',
    },
  };

  constructor(
    private readonly transport: HttpTransport,
    private readonly clock: Clock,
    private readonly endpoint = 'https://api.deps.dev/v3',
  ) {}

  async enrich(
    exactPurl: string,
    signal?: AbortSignal,
  ): Promise<EnrichmentResult> {
    const parsed = parsePurl(exactPurl);
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const system = systems[parsed.type as keyof typeof systems];
    if (!system)
      throw new ProviderError(
        'UNSUPPORTED_ECOSYSTEM',
        `deps.dev does not support ${parsed.type}`,
      );
    if (!parsed.version)
      throw new ProviderError(
        'VERSION_NOT_FOUND',
        'deps.dev enrichment requires an exact PURL',
      );
    const nativeName =
      parsed.namespace === undefined
        ? parsed.name
        : `@${parsed.namespace.replace(/^@/, '')}/${parsed.name}`;
    const url = `${this.endpoint.replace(/\/$/, '')}/systems/${system}/packages/${encodeURIComponent(nativeName)}/versions/${encodeURIComponent(parsed.version)}`;
    const response = await this.transport.request({
      url,
      signal,
      maximumBytes: 4 * 1024 * 1024,
      headers: { accept: 'application/json' },
    });
    const body = json<DepsDevVersion>(response);
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const rawDigest = await canonicalDigest(
      JSON.parse(JSON.stringify(body)) as JsonValue,
    );
    const record: ProviderRecord<DepsDevVersion> = {
      key: exactPurl,
      endpoint: response.url,
      ...(!(header(response, 'etag') === undefined) && {
        etag: header(response, 'etag'),
      }),
      body,
      rawBody:
        response.body.byteLength === 0
          ? // SAFETY: The surrounding boundary establishes the asserted domain contract.
            canonicalBytes(JSON.parse(JSON.stringify(body)) as JsonValue)
          : response.body,
      retrievedAt: this.clock.now(),
    };
    const warnings = [
      {
        code: 'DEPSDEV_NATIVE_SEMANTICS_INCOMPLETE',
        message:
          'deps.dev graph data is enrichment only; target and native feature semantics remain authoritative in ecosystem adapters',
      },
    ];
    if (Object.keys(parsed.qualifiers).length > 0)
      warnings.push({
        code: 'DEPSDEV_QUALIFIERS_NOT_APPLIED',
        message: 'deps.dev lookup does not apply PURL qualifiers',
      });
    let dependencies: DepsDevDependencies | undefined;
    let dependenciesDigest:
      | Awaited<ReturnType<typeof canonicalDigest>>
      | undefined;
    try {
      const dependencyResponse = await this.transport.request({
        url: `${url}:dependencies`,
        signal,
        maximumBytes: 4 * 1024 * 1024,
        headers: { accept: 'application/json' },
      });
      dependencies = json<DepsDevDependencies>(dependencyResponse);
      dependenciesDigest = await canonicalDigest(
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        JSON.parse(JSON.stringify(dependencies)) as JsonValue,
      );
    } catch (error) {
      if (
        !(error instanceof ProviderError) ||
        error.code !== 'PACKAGE_NOT_FOUND'
      )
        throw error;
      warnings.push({
        code: 'DEPSDEV_DEPENDENCIES_NOT_AVAILABLE',
        message:
          'deps.dev did not provide dependency data for this package version',
      });
    }
    return {
      subjectPurl: exactPurl,
      providerId: this.providerId,
      extensions: {
        'deps.dev/version': body,
        'deps.dev/rawDigest': rawDigest,
        'deps.dev/targetSpecific': false,
        ...(!(dependencies === undefined) && {
          'deps.dev/dependencies': dependencies,
          'deps.dev/dependenciesDigest': dependenciesDigest,
        }),
      },
      source: record,
      warnings,
      semanticLoss: [
        semanticLoss(
          // SAFETY: The surrounding boundary establishes the asserted domain contract.
          parsed.type as keyof typeof systems,
          'DEPSDEV_GRAPH_NOT_NATIVE_EQUIVALENT',
          '/dependencies',
          'deps.dev dependency graphs may omit target, feature, or qualifier-specific native semantics',
          'Facts are attached as optional enrichment only',
        ),
      ],
    };
  }
}
