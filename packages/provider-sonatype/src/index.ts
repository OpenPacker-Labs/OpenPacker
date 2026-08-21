import { canonicalDigest, canonicalBytes } from '@openpacker/canonical';
import type { JsonValue } from '@openpacker/contracts';
import {
  header,
  json,
  parsePurl,
  ProviderError,
  type Clock,
  type CredentialResolver,
  type EnrichmentProvider,
  type EnrichmentResult,
  type HttpTransport,
  type ProviderCapabilities,
  type ProviderRecord,
} from '@openpacker/adapter-core';

export interface SonatypeComponent {
  purl?: string;
  componentIdentifier?: string;
  policyEvaluation?: unknown;
  securityData?: unknown;
  [key: string]: unknown;
}

export interface SonatypeResponse {
  components?: SonatypeComponent[];
  component?: SonatypeComponent;
  [key: string]: unknown;
}

export class SonatypeProvider implements EnrichmentProvider {
  readonly providerId = 'sonatype';
  readonly capabilities: ProviderCapabilities = {
    operations: ['enrich'],
    purlTypes: ['npm', 'cargo', 'nuget'],
    qualifierSupport: 'partial',
    targetSpecificSemantics: false,
    offlineReplay: true,
    extensions: {
      'openpacker.dev/credential-mode': 'secret-reference',
      'openpacker.dev/provider-extension': 'sonatype/v1',
    },
  };

  constructor(
    private readonly transport: HttpTransport,
    private readonly credentials: CredentialResolver,
    private readonly clock: Clock,
    private readonly endpoint: string,
    private readonly secretReference: string,
  ) {
    const protocol = new URL(endpoint).protocol;
    if (protocol !== 'https:')
      throw new ProviderError(
        'INVALID_PROVIDER_ENDPOINT',
        'Sonatype endpoint must use HTTPS',
      );
  }

  async enrich(
    exactPurl: string,
    signal?: AbortSignal,
  ): Promise<EnrichmentResult> {
    const parsed = parsePurl(exactPurl);
    if (!parsed.version)
      throw new ProviderError(
        'VERSION_NOT_FOUND',
        'Sonatype enrichment requires an exact PURL',
      );
    const secretHeaders = await this.credentials.resolve(
      this.secretReference,
      signal,
    );
    const url = `${this.endpoint.replace(/\/$/, '')}/api/v2/components/details?purl=${encodeURIComponent(exactPurl)}`;
    const response = await this.transport.request({
      url,
      signal,
      maximumBytes: 4 * 1024 * 1024,
      headers: { accept: 'application/json', ...secretHeaders },
    });
    const body = json<SonatypeResponse>(response);
    const candidates =
      body.components ?? (body.component === undefined ? [] : [body.component]);
    const exact = candidates.filter(
      (candidate) => candidate.purl === exactPurl,
    );
    const warnings = [];
    if (exact.length === 0 && candidates.length > 0)
      warnings.push({
        code: 'SONATYPE_COORDINATE_MISMATCH',
        message:
          'Provider returned components that do not exactly match the canonical PURL',
      });
    if (exact.length > 1)
      warnings.push({
        code: 'SONATYPE_COORDINATE_AMBIGUOUS',
        message: 'Provider returned multiple exact PURL matches',
      });
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const recordDigest = await canonicalDigest(body as unknown as JsonValue);
    const record: ProviderRecord<SonatypeResponse> = {
      key: exactPurl,
      endpoint: response.url,
      ...(!(header(response, 'etag') === undefined) && {
        etag: header(response, 'etag'),
      }),
      body,
      rawBody:
        response.body.byteLength === 0
          ? // SAFETY: The surrounding boundary establishes the asserted domain contract.
            canonicalBytes(body as unknown as JsonValue)
          : response.body,
      retrievedAt: this.clock.now(),
    };
    return {
      subjectPurl: exactPurl,
      providerId: this.providerId,
      extensions: {
        'sonatype/v1': {
          matches: exact,
          unmatchedCandidates: candidates.filter(
            (candidate) => candidate.purl !== exactPurl,
          ),
          recordDigest,
        },
      },
      source: record,
      warnings,
      semanticLoss: [],
    };
  }
}
