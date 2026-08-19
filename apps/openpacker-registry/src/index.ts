/**
 * A PREX registry.
 *
 * Serves the registry HTTP binding (`spec/prex/v1/registry-api.md`): a service
 * index at a well-known path, package manifests, versions, cursor-paginated
 * listing with `updatedSince` for mirrors, and signed publish.
 *
 * Unlike `openpackerd`, this is *meant* to be reachable. The control plane is
 * unauthenticated and binds loopback by design; a registry that nobody can
 * reach is not a registry. So the default inverts — it binds where it is told,
 * and instead refuses to start with publishing open to anyone unless an
 * operator says so out loud.
 */

import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { HttpTransport } from '@openpacker/adapter-core';
import {
  canonicalBytes,
  canonicalDigest,
  formatDigest,
  parseCanonicalJson,
} from '@openpacker/canonical';
import type {
  Digest,
  JsonValue,
  PackageManifest,
  Problem,
  RegistryEntry,
  SignedStatusUpdate,
} from '@openpacker/contracts';
import { createPrexValidator, validateContract } from '@openpacker/conformance';
import { Ed25519Signer, Ed25519Verifier } from '@openpacker/trust';
import {
  RegistryStore,
  RegistryStoreError,
  type StoredEntry,
} from './store.js';
import {
  keyHistory,
  mayPublish,
  revocationListDigest,
  rotationMessage,
  signatureStatus,
  verifyRotation,
  type KeyRotation,
  type RevocationList,
} from './keys.js';
import {
  checkServiceability,
  isStale,
  type ServiceabilityRecord,
} from './serviceability.js';
import {
  holderOf,
  quotaState,
  redirectDigest,
  redirectMessage,
  resolveRedirect,
  retryAfterSeconds,
  type PackageRedirect,
  type QuotaPolicy,
} from './holders.js';
import {
  acceptedVersions,
  normalise,
  representableVersions,
  type ManifestMigration,
} from './normalise.js';
import {
  Federation,
  type ConfiguredSource,
  type FederationOptions,
} from './sources.js';

export const WELL_KNOWN = '/.well-known/prex-registry';
const PUBLISH_SCHEMA =
  'https://openpacker.dev/spec/prex/v1/schemas/registry-api.schema.json#/$defs/RegistryPublishRequest';
const REDIRECT_SCHEMA =
  'https://openpacker.dev/spec/prex/v1/schemas/registry-api.schema.json#/$defs/SignedPackageRedirect';
const STATUS_SCHEMA =
  'https://openpacker.dev/spec/prex/v1/schemas/registry-api.schema.json#/$defs/SignedStatusUpdate';
/**
 * Publishes per holder per hour, by default.
 *
 * MCP closed daily publish limits as unnecessary and later measured what
 * unlimited publishing produced. A default has to exist, because a limit an
 * operator must opt into is a limit almost nobody runs with — and it is charged
 * per holder, since a per-namespace budget is defeated by taking out another
 * namespace, which costs one DNS record.
 */
const DEFAULT_QUOTA: QuotaPolicy = { limit: 120, windowSeconds: 3600 };
const DEFAULT_LIMIT = 50;
const MAXIMUM_LIMIT = 250;
const STATUS_FRESHNESS_MILLISECONDS = 5 * 60 * 1000;

export interface RegistryOptions {
  registryId: string;
  displayName?: string;
  /** Purl types this registry serves. Advertised in the service index. */
  purlTypes: readonly string[];
  store?: RegistryStore;
  databasePath?: string;
  clock?: { now: () => string };
  /**
   * Signing key. When present the registry counter-signs what it accepts, so a
   * mirror can verify rather than trust. Absent means it stores what it is
   * given and offers nothing of its own to check.
   */
  signer?: Ed25519Signer;
  /** Public keys by id, for verifying publisher signatures. */
  publisherKeys?: Readonly<Record<string, JsonWebKey>>;
  /**
   * Accept publishes with no signature and no namespace proof.
   *
   * Off by default and named plainly: a registry in this mode is the only
   * thing any consumer can check, which is a decision an operator should make
   * deliberately rather than inherit.
   */
  anonymousPublish?: boolean;
  /**
   * Upstream sources this registry fronts. Configuration order is precedence,
   * and what this registry itself publishes always wins over all of them.
   */
  sources?: readonly ConfiguredSource[];
  /** How upstream registries are reached. See FederationOptions. */
  registryClientFactory?: FederationOptions['clientFactory'];
  /**
   * How long a serviceability record is trusted before the next read triggers
   * a re-check. Zero disables checking entirely.
   */
  serviceabilityTtlMilliseconds?: number;
  /**
   * Operator-authorized transport for reaching what a manifest advertises.
   * Absent disables probes; publisher locations never authorize registry egress.
   */
  serviceabilityTransport?: HttpTransport;
  /** Publish allowance, charged per namespace holder. See DEFAULT_QUOTA. */
  quota?: QuotaPolicy;
  /**
   * Conversions between manifest versions, for read-time negotiation.
   *
   * There is one version today, so this is empty by default. It is an option
   * rather than a constant because the registry that needs a migration is the
   * one already holding documents written before anyone wrote it.
   */
  manifestMigrations?: readonly ManifestMigration[];
  logger?: boolean;
  bodyLimit?: number;
}

export function createRegistry(options: RegistryOptions): FastifyInstance {
  const store = options.store ?? new RegistryStore(options.databasePath);
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const validator = createPrexValidator();
  const serviceabilityTtl = options.serviceabilityTtlMilliseconds ?? 86_400_000;
  const quota = options.quota ?? DEFAULT_QUOTA;
  const migrations = options.manifestMigrations ?? [];
  // Checks are triggered by reads, so at most one is in flight per package —
  // otherwise a popular package under load would fan out one request per
  // reader to somebody else's origin, which is a denial of service the
  // registry would be conducting on a publisher's behalf.
  const inFlight = new Set<string>();
  const federation =
    options.sources && options.sources.length > 0
      ? new Federation({
          sources: options.sources,
          registryId: options.registryId,
          ...(options.registryClientFactory === undefined
            ? {}
            : { clientFactory: options.registryClientFactory }),
        })
      : undefined;
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: options.bodyLimit ?? 4 * 1024 * 1024,
  });

  // Canonical JSON only, matching openpackerd: a document whose digest is the
  // thing under signature cannot be read by a parser that accepts duplicate
  // keys and silently keeps one.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    /^application\/(?:[a-z0-9.+-]+\+)?json$/u,
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        done(null, parseCanonicalJson(body as string));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-openpacker-registry-id', options.registryId);
    return payload;
  });

  /**
   * Re-check what a manifest advertises, if nobody has recently.
   *
   * Deliberately fire-and-forget: a read that waited on somebody else's origin
   * would make this registry's latency a function of every publisher's uptime.
   */
  function scheduleCheck(
    entry: StoredEntry,
    known: ServiceabilityRecord | undefined,
  ): void {
    const transport = options.serviceabilityTransport;
    if (serviceabilityTtl <= 0 || !transport) return;
    const key = `${entry.name}@${entry.version}`;
    if (inFlight.has(key)) return;
    if (!isStale(known, serviceabilityTtl, Date.parse(clock.now()))) return;

    const distribution = entry.manifest.distributions?.[0];
    if (!distribution?.locations?.length) return;

    inFlight.add(key);
    void (async () => {
      try {
        const record = await checkServiceability({
          locations: distribution.locations!,
          ...(distribution.digest === undefined
            ? {}
            : { digest: distribution.digest }),
          ...(distribution.size === undefined
            ? {}
            : { size: distribution.size }),
          transport,
          now: clock.now,
        });
        store.recordServiceability(entry.name, entry.version, record);
      } catch {
        // A failure to run the check is not a fact about the package.
      } finally {
        inFlight.delete(key);
      }
    })();
  }

  /**
   * A key's public JWK, following rotation chains.
   *
   * A key introduced by a rotation is as usable as one the operator
   * configured, or rotating would require an operator round-trip and nobody
   * would rotate.
   */
  function publisherKeyFor(keyId: string): JsonWebKey | undefined {
    const configured = options.publisherKeys?.[keyId];
    if (configured) return configured;
    return store.rotations().find((rotation) => rotation.nextKeyId === keyId)
      ?.nextPublicKey;
  }

  const advertised = [
    'prex.registry.search/1',
    'prex.registry.enumerate-versions/1',
    'prex.registry.package-manifest/1',
    'prex.registry.sync/1',
    'prex.registry.publish/1',
    'prex.registry.key-lifecycle/1',
  ];

  app.get(WELL_KNOWN, async (_request, reply) =>
    sendJson(reply, {
      registryDefinitionVersion: '1',
      registryId: options.registryId,
      ...(options.displayName === undefined
        ? {}
        : { displayName: options.displayName }),
      purlTypes: [...options.purlTypes],
      protocol: { native: 'prex-registry-v1', transport: ['https'] },
      resources: [{ '@id': '/v1', '@type': advertised }],
      // No prex.registry.artifact/1: this serves metadata, and its manifests'
      // locations point upstream. Advertising it would promise bytes.
      features: {
        offlineReplay: false,
        installSideEffects: 'none',
        reversibility: 'none',
        requiresElevation: 'never',
      },
    } as unknown as JsonValue),
  );

  /**
   * The revocation list, signed.
   *
   * A revocation a client cannot verify is a rumour, and an attacker able to
   * forge or strip one has undone the signing scheme entirely. Served even when
   * empty, so a client can tell "this registry revokes nothing" from "this
   * registry does not do revocation" — the second is a reason to distrust it.
   */
  app.get('/v1/revocations', async (_request, reply) => {
    const list: RevocationList = {
      revocationListVersion: '1',
      registryId: options.registryId,
      serial: store.revocationSerial(),
      issuedAt: clock.now(),
      revoked: store.revocations(),
    };
    const listDigest = await revocationListDigest(list);
    const signatures = options.signer
      ? [
          {
            algorithm: options.signer.algorithm,
            keyId: options.signer.keyId,
            signature: await options.signer.sign(
              new TextEncoder().encode(formatDigest(listDigest)),
            ),
            role: 'registry' as const,
          },
        ]
      : [];
    return sendJson(reply, {
      list,
      listDigest,
      signatures,
    } as unknown as JsonValue);
  });

  /**
   * Rotate a key, attested by its predecessor.
   *
   * The old key is revoked `from-now`, so everything it signed before this
   * moment keeps verifying and it can no longer publish. That continuity is
   * the reason anyone rotates at all.
   */
  app.post('/v1/keys/rotations', async (request, reply) => {
    try {
      const rotation = request.body as KeyRotation;
      if (!rotation?.previousKeyId || !rotation.nextKeyId)
        throw new PublishError(
          'INVALID_REQUEST',
          400,
          'A rotation names the key it succeeds and the key taking over',
        );
      const previous = publisherKeyFor(rotation.previousKeyId);
      if (!previous)
        throw new PublishError(
          'INVALID_SIGNATURE',
          403,
          `Key ${rotation.previousKeyId} is not known to this registry`,
        );
      if (!(await verifyRotation(rotation, previous)))
        // Anyone could otherwise nominate a successor to someone else's key.
        throw new PublishError(
          'INVALID_SIGNATURE',
          400,
          `The rotation is not signed by ${rotation.previousKeyId}`,
        );

      store.recordRotation(rotation);
      store.rotateNamespaceKey(rotation.previousKeyId, rotation.nextKeyId);
      store.revoke({
        keyId: rotation.previousKeyId,
        revokedAt: rotation.rotatedAt,
        effective: 'from-now',
        reason: 'rotated',
        replacedBy: rotation.nextKeyId,
      });
      reply.code(201);
      return sendJson(reply, {
        rotated: rotation.previousKeyId,
        to: rotation.nextKeyId,
      } as unknown as JsonValue);
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * Who holds what.
   *
   * The MCP survey that found one domain behind 75 namespaces had to go and
   * look; the data existed only as a scatter of individual proofs. Ordering by
   * namespace count puts the concentrated holders first, because a list sorted
   * by name buries exactly what this route is for.
   */
  app.get('/v1/holders', async (_request, reply) =>
    sendJson(reply, {
      holders: store.holders(),
    } as unknown as JsonValue),
  );

  app.get<{ Params: { id: string } }>(
    '/v1/holders/:id',
    async (request, reply) => {
      const id = decodeURIComponent(request.params.id);
      const holder = store.holder(id);
      if (!holder)
        return sendProblem(
          reply,
          problem('PACKAGE_NOT_FOUND', 404, `No holder ${id} here`),
        );
      const state = quotaState(
        store.recentPublishes(
          id,
          Date.parse(clock.now()) - quota.windowSeconds * 1000,
        ),
        quota,
        Date.parse(clock.now()),
      );
      return sendJson(reply, {
        ...holder,
        quota: state,
      } as unknown as JsonValue);
    },
  );

  /**
   * Move a name, keeping the old one resolvable.
   *
   * MCP has no answer here: a publisher moving from a forge namespace to their
   * own domain has to ask a maintainer, and everything pinned to the old name
   * is their problem. The redirect is a signed document rather than an HTTP
   * 308 so that a mirror — which sees only bytes — can check the move came from
   * the party that actually held both names.
   */
  app.post<{ Params: { name: string } }>(
    '/v1/packages/:name/rename',
    async (request, reply) => {
      try {
        const from = decodeURIComponent(request.params.name);
        const body = request.body as {
          redirect?: PackageRedirect;
          signatures?: { keyId: string; signature: string }[];
        };
        assertValid(REDIRECT_SCHEMA, body as unknown as JsonValue, validator);
        const redirect = body.redirect as PackageRedirect;
        if (redirect.from !== from)
          throw new PublishError(
            'INVALID_REQUEST',
            400,
            `The redirect renames ${redirect.from}, but this route is ${from}`,
          );
        if (store.versions(from).length === 0)
          throw new PublishError(
            'PACKAGE_NOT_FOUND',
            404,
            `No package named ${from}`,
          );
        if (store.versions(redirect.to).length > 0)
          // Otherwise a rename is a way to shadow a name somebody else is
          // already publishing under.
          throw new PublishError(
            'POLICY_DENIED',
            409,
            `${redirect.to} already exists here`,
          );

        const message = await redirectMessage(redirect);
        const signatures = body.signatures ?? [];
        let holdsBoth = false;
        for (const signature of signatures) {
          const jwk = publisherKeyFor(signature.keyId);
          if (!jwk)
            throw new PublishError(
              'INVALID_SIGNATURE',
              403,
              `Key ${signature.keyId} is not known to this registry`,
            );
          if (!mayPublish(signature.keyId, store.revocations()))
            throw new PublishError(
              'POLICY_DENIED',
              403,
              `Key ${signature.keyId} is revoked`,
            );
          const verifier = await Ed25519Verifier.fromJwk(signature.keyId, jwk);
          if (!(await verifier.verify(message, signature.signature)))
            throw new PublishError(
              'INVALID_SIGNATURE',
              400,
              `Signature from ${signature.keyId} does not verify`,
            );
          // One key must hold *both* names. A key holding only the source could
          // point its users at someone else's package; a key holding only the
          // destination could claim any package it liked.
          if (
            holdsName(store, from, signature.keyId) &&
            holdsName(store, redirect.to, signature.keyId)
          )
            holdsBoth = true;
        }
        if (!holdsBoth)
          throw new PublishError(
            'POLICY_DENIED',
            403,
            `A rename must be signed by one key permitted to publish both ${from} and ${redirect.to}`,
          );

        const digest = await redirectDigest(redirect);
        store.rename(from, redirect.to, clock.now());
        store.recordRedirect(redirect, formatDigest(digest), signatures);
        reply.code(201);
        return sendJson(reply, {
          redirect,
          redirectDigest: digest,
          signatures,
        } as unknown as JsonValue);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get<{ Params: { name: string } }>(
    '/v1/packages/:name/redirect',
    async (request, reply) => {
      const from = decodeURIComponent(request.params.name);
      const moved = store.redirect(from);
      if (!moved)
        return sendProblem(
          reply,
          problem('PACKAGE_NOT_FOUND', 404, `${from} has not moved`),
        );
      const [algorithm, value] = moved.digest.split(':');
      return sendJson(reply, {
        redirect: moved.redirect,
        redirectDigest: { algorithm, value },
        signatures: moved.signatures,
      } as unknown as JsonValue);
    },
  );

  app.get('/v1/health', async (_request, reply) =>
    sendJson(reply, { status: store.ready() ? 'ok' : 'unavailable' }),
  );

  app.get<{
    Querystring: {
      search?: string;
      purlType?: string;
      updatedSince?: string;
      limit?: string;
      cursor?: string;
    };
  }>('/v1/packages', async (request, reply) => {
    try {
      const limit = boundedLimit(request.query.limit);
      const after = decodeCursor(request.query.cursor);
      const { entries, hasMore } = store.list({
        limit,
        ...(request.query.search === undefined
          ? {}
          : { search: request.query.search }),
        ...(request.query.purlType === undefined
          ? {}
          : { purlType: request.query.purlType }),
        ...(request.query.updatedSince === undefined
          ? {}
          : { updatedSince: assertTimestamp(request.query.updatedSince) }),
        ...(after === undefined ? {} : { afterSequence: after }),
      });
      // The cursor is the last row *read*, not the last row returned: purlType
      // filtering happens after the page is taken, and using the filtered tail
      // would replay rows that were already skipped.
      const lastRead = entries.at(-1)?.sequence ?? after;
      const local = entries.map((entry) => toRegistryEntry(entry, options));

      // Upstreams are consulted only once the local pages are exhausted, so a
      // mirror walking this registry replays its own records in a stable
      // sequence before anything relayed shows up.
      let relayed: RegistryEntry[] = [];
      let unavailable: { sourceId: string; reason: string }[] = [];
      if (
        federation &&
        !hasMore &&
        request.query.updatedSince === undefined &&
        request.query.search !== undefined
      ) {
        const found = await federation.search(
          request.query.search,
          limit - local.length,
        );
        const held = new Set(local.map((entry) => entry.manifest.name));
        relayed = found.entries.filter(
          (entry) => !held.has(entry.manifest.name),
        );
        unavailable = found.unavailable;
      }

      return sendJson(reply, {
        packages: [...local, ...relayed],
        metadata: {
          count: local.length + relayed.length,
          nextCursor:
            hasMore && lastRead !== undefined ? encodeCursor(lastRead) : null,
          // Which search actually ran. A registry silently falling back to a
          // full scan looks identical to one that is fast until it is not.
          ...(request.query.search === undefined
            ? {}
            : {
                searchMode: store.searchIndexed
                  ? ('indexed' as const)
                  : ('scan' as const),
              }),
          // Naming what did not answer is the difference between "no results"
          // and "some sources were down"; a mirror must not read one as the
          // other.
          ...(unavailable.length > 0 ? { unavailable } : {}),
        },
      } as unknown as JsonValue);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get<{ Params: { name: string } }>(
    '/v1/packages/:name/versions',
    async (request, reply) => {
      const asked = decodeURIComponent(request.params.name);
      const followed = follow(store, asked);
      if ('cycle' in followed)
        return sendProblem(
          reply,
          problem(
            'INTERNAL_ERROR',
            500,
            `The redirects for ${asked} loop; this registry will not follow them`,
          ),
        );
      const name = followed.name;
      const versions = store.versions(name);
      if (versions.length === 0)
        return sendProblem(
          reply,
          problem('PACKAGE_NOT_FOUND', 404, `No package named ${asked}`),
        );
      // Say plainly that the name moved. A client that silently gets a
      // different package back than the one it asked for has no way to notice,
      // and a lockfile should record what it actually resolved.
      if (followed.hops.length > 0)
        reply.header('x-openpacker-renamed-from', asked);
      return sendJson(reply, {
        name,
        ...(followed.hops.length > 0
          ? { redirectedFrom: asked, redirects: followed.hops }
          : {}),
        versions: versions.map((entry) => ({
          version: entry.version,
          status: entry.status,
          isLatest: entry.isLatest,
          publishedAt: entry.publishedAt,
        })),
      } as unknown as JsonValue);
    },
  );

  app.get<{ Params: { name: string; version: string } }>(
    '/v1/packages/:name/versions/:version',
    async (request, reply) => {
      const asked = decodeURIComponent(request.params.name);
      const version = decodeURIComponent(request.params.version);
      const followed = follow(store, asked);
      if ('cycle' in followed)
        return sendProblem(
          reply,
          problem(
            'INTERNAL_ERROR',
            500,
            `The redirects for ${asked} loop; this registry will not follow them`,
          ),
        );
      const name = followed.name;
      if (name !== asked) reply.header('x-openpacker-renamed-from', asked);
      // Withdrawn versions stay retrievable by exact version: a consumer
      // holding a lockfile needs to learn a version was pulled, and a 404
      // tells it nothing.
      const entry = store.get(name, version);
      if (entry) {
        const known = store.serviceability(name, version);
        // Never block the read. The answer goes out with whatever is known;
        // the next reader sees the fresher result.
        scheduleCheck(entry, known);

        // Meet the client where it is, or say plainly that it cannot be met.
        // Handing over a document in a version the client cannot parse moves
        // the failure to install time, where nobody can do anything about it.
        const accepted = acceptedVersions(request.headers.accept);
        const served = normalise(entry.manifest, accepted, migrations);
        if (!served) {
          const stored = Number(entry.manifest.packageManifestVersion);
          return sendProblem(
            reply,
            problem(
              'UNSUPPORTED_SEMANTICS_PROFILE',
              406,
              'No acceptable manifest version',
              `This document is version ${stored} and can be served as ` +
                `${representableVersions(stored, migrations).join(', ')}; ` +
                `you asked for ${accepted.join(', ')}.`,
            ),
          );
        }
        return sendJson(
          reply,
          toRegistryEntry(
            { ...entry, manifest: served },
            options,
            known,
          ) as unknown as JsonValue,
          // Name the version in the response, so a client that negotiated one
          // does not have to read the body to find out what it got.
          `application/vnd.prex.manifest.v${served.packageManifestVersion}+json`,
        );
      }
      // Local wins; only then is an upstream asked. An upstream that starts
      // publishing a name this registry already serves must not take it over.
      const relayed = await federation?.find(name, version);
      if (relayed)
        return sendJson(reply, relayed.entry as unknown as JsonValue);
      return sendProblem(
        reply,
        problem('VERSION_NOT_FOUND', 404, `${name}@${version} is not here`),
      );
    },
  );

  app.post('/v1/publish', async (request, reply) => {
    try {
      const body = request.body as {
        manifest?: PackageManifest;
        manifestDigest?: Digest;
        signatures?: {
          algorithm: string;
          keyId: string;
          signature: string;
          role?: string;
        }[];
      };
      if (!body?.manifest)
        throw new PublishError(
          'INVALID_REQUEST',
          400,
          'A manifest is required',
        );

      // Validate before anything is stored. A registry that keeps a document
      // it cannot honour has moved the cost onto every client that later reads
      // it — and unlike the registry, a client meets it at install time with no
      // way to refuse.
      //
      // One check, not two: RegistryPublishRequest embeds PackageManifest, so
      // validating the envelope validates the manifest, and the reported path
      // (/manifest/distributions/0/purlType) says more than a second pass
      // would.
      assertValid(PUBLISH_SCHEMA, body as unknown as JsonValue, validator);

      // Re-derive rather than trust. A caller-supplied digest is a claim about
      // bytes the registry is holding, and it is holding them.
      const digest = await canonicalDigest(
        body.manifest as unknown as JsonValue,
      );
      if (
        body.manifestDigest &&
        (body.manifestDigest.algorithm !== digest.algorithm ||
          body.manifestDigest.value !== digest.value)
      )
        throw new PublishError(
          'DIGEST_MISMATCH',
          400,
          `Stated ${formatDigest(body.manifestDigest)} but the manifest hashes to ${formatDigest(digest)}`,
        );

      const signatures = body.signatures ?? [];
      if (signatures.length === 0 && options.anonymousPublish !== true)
        throw new PublishError(
          'INVALID_SIGNATURE',
          401,
          'This registry requires a signed manifest. Start it with ' +
            'anonymousPublish only if you accept being the only thing anyone can check.',
        );

      const message = new TextEncoder().encode(formatDigest(digest));
      for (const signature of signatures) {
        const jwk = publisherKeyFor(signature.keyId);
        if (!jwk)
          throw new PublishError(
            'INVALID_SIGNATURE',
            403,
            `Key ${signature.keyId} is not known to this registry`,
          );
        // Both effects stop a key publishing. Retiring a key means it stops
        // being used going forward; only whether its past work still counts
        // depends on which effect was recorded.
        if (!mayPublish(signature.keyId, store.revocations()))
          throw new PublishError(
            'POLICY_DENIED',
            403,
            `Key ${signature.keyId} is revoked and can no longer publish`,
          );
        const verifier = await Ed25519Verifier.fromJwk(signature.keyId, jwk);
        if (!(await verifier.verify(message, signature.signature)))
          throw new PublishError(
            'INVALID_SIGNATURE',
            400,
            `Signature from ${signature.keyId} does not verify`,
          );
      }

      // A valid signature says the document was not altered. It says nothing
      // about who may use this name, which is a separate question.
      //
      // Anonymous publishes share one budget deliberately: with nobody to
      // attribute them to there is nothing else to charge, and a per-request
      // allowance would be no allowance at all.
      const holder =
        signatures.length > 0
          ? assertNamespace(store, body.manifest.name, signatures)
          : 'operator:anonymous';

      // A name that has moved cannot be published to at the old name; that is
      // what the redirect promised everyone reading it.
      const moved = store.redirect(body.manifest.name);
      if (moved)
        throw new PublishError(
          'POLICY_DENIED',
          409,
          `${body.manifest.name} was ${moved.redirect.reason}d to ${moved.redirect.to}; publish there`,
        );

      assertQuota(store, holder, quota, clock);

      const stored = store.publish({
        manifest: body.manifest,
        manifestDigest: formatDigest(digest),
        signatures: await counterSign(signatures, message, options.signer),
        now: clock.now(),
      });
      // Charged only once the publish actually happened. Charging on the way in
      // would let a rejected request — a bad signature, a name someone else
      // holds — spend the allowance of the publisher whose name was borrowed.
      if (stored.created) store.recordPublish(holder, Date.parse(clock.now()));
      reply.code(stored.created ? 201 : 200);
      return sendJson(reply, {
        entry: toRegistryEntry(stored.entry, options),
      } as unknown as JsonValue);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.patch<{ Params: { name: string; version: string } }>(
    '/v1/packages/:name/versions/:version/status',
    async (request, reply) => {
      try {
        const body = request.body as SignedStatusUpdate;
        assertValid(STATUS_SCHEMA, body as unknown as JsonValue, validator);
        const name = decodeURIComponent(request.params.name);
        const version = decodeURIComponent(request.params.version);
        if (body.update.name !== name || body.update.version !== version)
          throw new PublishError(
            'INVALID_REQUEST',
            400,
            'The signed lifecycle update does not match this package route',
          );
        assertFreshStatusUpdate(body.update.issuedAt, clock.now());
        const updateDigest = await canonicalDigest(
          body.update as unknown as JsonValue,
        );
        if (
          body.updateDigest.algorithm !== updateDigest.algorithm ||
          body.updateDigest.value !== updateDigest.value
        )
          throw new PublishError(
            'DIGEST_MISMATCH',
            400,
            `Stated ${formatDigest(body.updateDigest)} but the lifecycle update hashes to ${formatDigest(updateDigest)}`,
          );
        await assertStatusAuthority(
          store,
          name,
          body.signatures,
          new TextEncoder().encode(formatDigest(updateDigest)),
          publisherKeyFor,
        );
        const entry = store.applyStatus({
          eventId: body.update.eventId,
          name,
          version,
          status: body.update.status,
          updateDigest: formatDigest(updateDigest),
          update: body.update as unknown as JsonValue,
          signatures: body.signatures,
          now: clock.now(),
        });
        return sendJson(
          reply,
          toRegistryEntry(entry, options) as unknown as JsonValue,
        );
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /**
   * Accept a consumer's report that something did not work.
   *
   * Corroboration only: it brings the next first-party check forward and
   * cannot set state. A registry that let anonymous reports mark a package
   * unreachable would be offering "report a competitor" as a feature.
   */
  app.post<{ Params: { name: string; version: string } }>(
    '/v1/packages/:name/versions/:version/observations',
    async (request, reply) => {
      const name = decodeURIComponent(request.params.name);
      const version = decodeURIComponent(request.params.version);
      if (!store.get(name, version))
        return sendProblem(
          reply,
          problem('VERSION_NOT_FOUND', 404, `${name}@${version} is not here`),
        );
      store.expireServiceability(name, version);
      reply.code(202);
      return sendJson(reply, {
        accepted: true,
        effect: 'The next read will re-check this package first-hand.',
      } as unknown as JsonValue);
    },
  );

  app.setNotFoundHandler(async (_request, reply) =>
    sendProblem(reply, problem('PACKAGE_NOT_FOUND', 404, 'Route not found')),
  );
  app.addHook('onClose', async () => store.close());
  return app;
}

/** Counter-sign what the registry accepted, as a distinct claim. */
async function counterSign(
  signatures: readonly {
    algorithm: string;
    keyId: string;
    signature: string;
    role?: string;
  }[],
  message: Uint8Array,
  signer?: Ed25519Signer,
): Promise<readonly unknown[]> {
  const publisher = signatures.map((signature) => ({
    ...signature,
    role: signature.role ?? 'publisher',
  }));
  if (!signer) return publisher;
  return [
    ...publisher,
    {
      algorithm: signer.algorithm,
      keyId: signer.keyId,
      signature: await signer.sign(message),
      // "I accepted this" is a different claim from "I wrote this".
      role: 'registry',
    },
  ];
}

/**
 * A signing key may publish under this name.
 *
 * The namespace is the leading dotted segments of the package name, so
 * `com.example.tool` is governed by `com.example`. A key bound to no namespace
 * governs nothing.
 */
function assertNamespace(
  store: RegistryStore,
  packageName: string,
  signatures: readonly { keyId: string }[],
): string {
  const candidates = namespacesOf(packageName);
  for (const namespace of candidates) {
    const permitted = new Set(store.keysFor(namespace));
    if (signatures.some((signature) => permitted.has(signature.keyId)))
      // The most specific matching namespace is the one that governs, and its
      // holder is who the publish is charged to.
      return (
        store.holderForNamespace(namespace) ?? holderOf(namespace, 'dns-txt')
      );
  }
  throw new PublishError(
    'POLICY_DENIED',
    403,
    `No signing key on this request is permitted to publish "${packageName}". ` +
      `An operator must bind it to one of: ${candidates.join(', ') || '(none)'}.`,
  );
}

function assertFreshStatusUpdate(issuedAt: string, nowValue: string): void {
  const issued = Date.parse(issuedAt);
  const now = Date.parse(nowValue);
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(now) ||
    issued > now ||
    now - issued > STATUS_FRESHNESS_MILLISECONDS
  )
    throw new PublishError(
      'POLICY_DENIED',
      403,
      'Lifecycle updates must be issued within the last five minutes',
    );
}

async function assertStatusAuthority(
  store: RegistryStore,
  packageName: string,
  signatures: readonly { keyId: string; signature: string }[],
  message: Uint8Array,
  keyFor: (keyId: string) => JsonWebKey | undefined,
): Promise<void> {
  let authorized = false;
  for (const signature of signatures) {
    const key = keyFor(signature.keyId);
    if (!key)
      throw new PublishError(
        'INVALID_SIGNATURE',
        403,
        `Key ${signature.keyId} is not known to this registry`,
      );
    if (!mayPublish(signature.keyId, store.revocations()))
      throw new PublishError(
        'POLICY_DENIED',
        403,
        `Key ${signature.keyId} is revoked`,
      );
    const verifier = await Ed25519Verifier.fromJwk(signature.keyId, key);
    if (!(await verifier.verify(message, signature.signature)))
      throw new PublishError(
        'INVALID_SIGNATURE',
        400,
        `Signature from ${signature.keyId} does not verify`,
      );
    if (holdsName(store, packageName, signature.keyId)) authorized = true;
  }
  if (!authorized)
    throw new PublishError(
      'POLICY_DENIED',
      403,
      `No signing key on this lifecycle update may mutate ${packageName}`,
    );
}

/** Where a name resolves today, after any renames. */
function follow(
  store: RegistryStore,
  name: string,
): { name: string; hops: readonly PackageRedirect[] } | { cycle: true } {
  // Cheap path: most names have never moved, and building the whole redirect
  // map on every read would make a rename tax every request in the registry.
  if (!store.redirect(name)) return { name, hops: [] };
  return resolveRedirect(name, store.redirects());
}

/** Whether a key is permitted to publish under any namespace governing a name. */
function holdsName(
  store: RegistryStore,
  packageName: string,
  keyId: string,
): boolean {
  return namespacesOf(packageName).some((namespace) =>
    store.keysFor(namespace).includes(keyId),
  );
}

/**
 * Refuse a publish that would exceed the holder's allowance.
 *
 * `Retry-After` is the moment the oldest publish in the window ages out, which
 * is the only time the answer actually changes. Any other number sends a client
 * back to be refused again, and a client refused twice retries harder.
 */
function assertQuota(
  store: RegistryStore,
  holderId: string,
  policy: QuotaPolicy,
  clock: { now: () => string },
): void {
  const now = Date.parse(clock.now());
  const state = quotaState(
    store.recentPublishes(holderId, now - policy.windowSeconds * 1000),
    policy,
    now,
  );
  if (state.remaining > 0) return;
  throw new QuotaError(
    `${holderId} has published ${policy.limit} times in the last ` +
      `${policy.windowSeconds} seconds`,
    retryAfterSeconds(state, now),
  );
}

/** `com.example.tool` → `com.example.tool`, `com.example`, `com`. */
function namespacesOf(name: string): string[] {
  const parts = name.split('.');
  const out: string[] = [];
  for (let index = parts.length; index > 0; index -= 1)
    out.push(parts.slice(0, index).join('.'));
  return out;
}

function toRegistryEntry(
  entry: StoredEntry,
  options: RegistryOptions,
  serviceability?: ServiceabilityRecord,
): RegistryEntry {
  const [algorithm, value] = entry.manifestDigest.split(':');
  return {
    manifest: entry.manifest,
    registryMetadata: {
      registryId: options.registryId,
      ...(entry.sourceId === undefined ? {} : { sourceId: entry.sourceId }),
      status: entry.status,
      publishedAt: entry.publishedAt,
      updatedAt: entry.updatedAt,
      isLatest: entry.isLatest,
      manifestDigest: { algorithm, value } as Digest,
      // Absent means nobody has looked yet, which is a different thing from
      // "we looked and it was fine".
      ...(serviceability === undefined ? {} : { serviceability }),
    },
    ...(entry.signatures.length > 0
      ? { signatures: entry.signatures as never }
      : {}),
  } as RegistryEntry;
}

/**
 * Cursors are opaque to clients and carry the last sequence read.
 *
 * Base64 rather than a bare number so nobody builds on the encoding — a client
 * that arithmetics on a cursor has coupled itself to this implementation.
 */
function encodeCursor(sequence: number): string {
  return Buffer.from(`seq:${sequence}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor?: string): number | undefined {
  if (cursor === undefined || cursor === '') return undefined;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^seq:(\d+)$/u.exec(decoded);
  if (!match)
    throw new PublishError(
      'INVALID_REQUEST',
      400,
      'Malformed pagination cursor',
    );
  return Number(match[1]);
}

function boundedLimit(value?: string): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new PublishError(
      'INVALID_REQUEST',
      400,
      'limit must be a positive integer',
    );
  return Math.min(parsed, MAXIMUM_LIMIT);
}

function assertTimestamp(value: string): string {
  if (Number.isNaN(Date.parse(value)))
    throw new PublishError(
      'INVALID_REQUEST',
      400,
      'updatedSince must be an RFC 3339 timestamp',
    );
  return value;
}

/**
 * Refuse a document that does not validate, naming where it failed.
 *
 * The first error only: a publisher fixes them one at a time, and a wall of
 * paths is harder to act on than the first thing that is wrong.
 */
function assertValid(
  schema: string,
  value: JsonValue,
  validator: ReturnType<typeof createPrexValidator>,
): void {
  const result = validateContract(schema, value, validator);
  if (result.valid) return;
  const first = result.errors[0];
  const where =
    first && 'instancePath' in first && first.instancePath
      ? first.instancePath
      : '/';
  const why =
    first && 'message' in first && first.message ? first.message : 'is invalid';
  throw new PublishError(
    'INVALID_REQUEST',
    400,
    `This is not a publishable document: ${where} ${why}`,
  );
}

class PublishError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PublishError';
  }
}

/** Over the allowance. Carries the wait, because a 429 without one is a guess. */
class QuotaError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = 'QuotaError';
  }
}

function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof QuotaError) {
    reply.header('retry-after', String(error.retryAfterSeconds));
    return sendProblem(
      reply,
      problem('RATE_LIMITED', 429, 'Publish quota exhausted', error.message),
    );
  }
  if (error instanceof PublishError)
    return sendProblem(
      reply,
      problem(
        error.code,
        error.status,
        'Registry request failed',
        error.message,
      ),
    );
  if (error instanceof RegistryStoreError)
    return sendProblem(
      reply,
      problem(
        error.code === 'VERSION_EXISTS'
          ? 'SNAPSHOT_MISMATCH'
          : error.code === 'EVENT_EXISTS'
            ? 'POLICY_DENIED'
            : 'PACKAGE_NOT_FOUND',
        error.code === 'VERSION_EXISTS' || error.code === 'EVENT_EXISTS'
          ? 409
          : 404,
        'Registry request failed',
        error.message,
      ),
    );
  // Nothing else reaches a caller: an internal message is a local path or a
  // query as often as it is useful.
  return sendProblem(
    reply,
    problem(
      'INTERNAL_ERROR',
      500,
      'The registry could not complete the request',
    ),
  );
}

function sendJson(
  reply: FastifyReply,
  value: JsonValue,
  mediaType = 'application/json',
): FastifyReply {
  reply.header('content-type', `${mediaType}; charset=utf-8`);
  return reply.send(Buffer.from(canonicalBytes(value)));
}

function sendProblem(reply: FastifyReply, value: Problem): FastifyReply {
  reply
    .code(value.status)
    .header('content-type', 'application/problem+json; charset=utf-8');
  return reply.send(Buffer.from(canonicalBytes(value as unknown as JsonValue)));
}

function problem(
  code: string,
  status: number,
  title: string,
  detail?: string,
): Problem {
  return {
    type: `https://openpacker.dev/problems/${code.toLowerCase().replaceAll('_', '-')}`,
    title,
    status,
    ...(detail === undefined ? {} : { detail }),
    code: code as Problem['code'],
    retryable: [429, 502, 503, 504].includes(status),
  };
}

export { RegistryStore } from './store.js';
