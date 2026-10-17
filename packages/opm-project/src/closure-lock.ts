import { echoed } from '@openpacker/adapter-core';
import { plainLine } from '@openpacker/canonical';
import type { PackageInstance } from '@openpacker/contracts';
import { binDeclarationsFromExecutables } from './bins.js';
import { requireAdapterRegistry } from './adapters.js';
import { codecFor } from './codecs.js';
import {
  bindVerifiedArtifactBytes,
  digestOf,
  inferFormat,
  nativeIntegrityOf,
} from './install.js';
import { allocateLockKeys } from './lock-keys.js';
import { storeKeyFromDigest } from './paths.js';
import {
  resolveRegistryArtifact,
  type ProviderPool,
  type RegistryArtifact,
  type RegistryOptions,
} from './registry.js';
import { resolveGraph, type ResolvedGraph } from './resolve.js';
import { solveGraph } from './solve.js';
import { purlPackageName, stripPurlVersion } from './spec.js';
import {
  applyAttestation,
  assertSupplyChainAllowed,
  captureFactsFromSourceUri,
  capturePublishTime,
  insideReleaseAge,
  lockAttestationFrom,
  lockPackageSupplyChainFields,
  projectPolicyDocument,
} from './supply-chain.js';
import type { LockPackage, OpmLockfile, OpmManifest } from './types.js';
import { OpmError } from './types.js';

/**
 * Lock entries for everything the direct set depends on.
 *
 * The closure is solved by the PREX engine (`solveGraph`), so the lock records a
 * set that was proved to satisfy every constraint together. Which selected
 * version each dependent uses is part of the answer: each entry says which
 * entries it requires (`dependencies`, and `aliases` for the ones it finds under
 * another name), and a name selected at more than one version has an entry per
 * version (ADR 0054).
 */

/**
 * The manifest constraint for a package, when its ecosystem can read it.
 *
 * `version` in opm.toml is whatever the user wrote, and an exact pin is not
 * always a valid range: PyPI wants `==1.0.0`, so a bare `1.0.0` fails to parse
 * and the whole closure comes back empty. Probe the codec and drop a range it
 * cannot read — candidate enumeration is bounded either way, and the solver is
 * pinned to the locked version regardless.
 */
function nativeRangeFor(
  pkg: LockPackage,
  manifest: OpmManifest,
): string | undefined {
  const declared = manifest.packages[pkg.alias]?.version;
  if (declared === undefined) return undefined;
  try {
    codecFor(pkg.ecosystem).parseNativeRange(declared);
    return declared;
  } catch {
    return undefined;
  }
}

/** What the closure of the direct entries adds to a lock. */
export interface TransitiveLock {
  /** The entries that are not direct, by lock key. */
  packages: Record<string, LockPackage>;
  /** Every selected entry's plain edges, by lock key. */
  dependencies: Record<string, string[]>;
  /** Every selected entry's edges under another name, by lock key. */
  aliases: Record<string, Record<string, string>>;
}

export async function resolveTransitive(input: {
  direct: readonly LockPackage[];
  manifest: OpmManifest;
  registryOptions?: RegistryOptions | undefined;
  pool: ProviderPool;
  previousLock?: OpmLockfile | undefined;
}): Promise<TransitiveLock> {
  // Only what came from a registry is walked through that registry. A package
  // pinned to a file, a catalog entry or a URL is not the registry's package of
  // that name, so asking the registry what it depends on would answer for a
  // different package, and could pull its dependencies in by name.
  const resolvable = input.direct.filter(
    (pkg) =>
      pkg.sourceKind === 'registry' &&
      requireAdapterRegistry().has(pkg.ecosystem),
  );
  if (resolvable.length === 0)
    return { packages: {}, dependencies: {}, aliases: {} };

  const policy = projectPolicyDocument(input.manifest);
  const evaluationTime = new Date().toISOString();
  const out: Record<string, LockPackage> = {};
  const dependencies: Record<string, string[]> = {};
  const aliases: Record<string, Record<string, string>> = {};
  let unresolved: ResolvedGraph['unresolved'] = [];
  let gated: ResolvedGraph['gated'] = [];
  try {
    const graph = await resolveGraph({
      pool: input.pool,
      candidateGate: async (exact, provider) =>
        (await insideReleaseAge(policy, provider, exact, evaluationTime))
          ? `published inside the ${policy.minimumReleaseAgeMinutes}-minute minimum release age`
          : undefined,
      roots: resolvable.map((pkg) => ({
        purl: stripPurlVersion(pkg.purl),
        ...(!(nativeRangeFor(pkg, input.manifest) === undefined) && {
          range: nativeRangeFor(pkg, input.manifest)!,
        }),
      })),
    });
    unresolved = graph.unresolved;
    gated = graph.gated;
    if (graph.packages.length === 0)
      throw new OpmError(
        'UNRESOLVABLE',
        'the registry returned nothing to resolve against',
      );

    const solved = await solveGraph({
      graph,
      policy: {
        allowYanked: policy.allowYanked,
        allowQuarantined: policy.allowQuarantined,
        // The solver has no evidence facts, so it can only be asked for the
        // one kind it establishes itself. Every other kind (sigstore,
        // packslip, a pinned key) is a fact about a downloaded release, and is
        // checked against each selected package below, before anything locks.
        requiredEvidence: policy.requiredEvidence.filter(
          (kind) => kind === 'receipt-signature',
        ),
        semanticLossMaximum: policy.semanticLossMaximum,
        acceptedOverlayAuthorities: input.manifest.policy
          ?.acceptedOverlayAuthorities ?? ['publisher'],
      },
      // Pin each root to the version the direct pass already locked. Left
      // unpinned, the closure can select a different release of a package the
      // lock has already decided, and that second copy lands as a transitive
      // entry beside the direct one.
      rootRequirements: resolvable.map((pkg) => ({
        purl: stripPurlVersion(pkg.purl),
        vers: `vers:${pkg.ecosystem}/${pkg.version}`,
      })),
    });

    // A direct entry keeps its manifest alias; the first, by key, when two
    // direct entries are the same release. The solve has one node for the
    // release, so the others are copies of that entry's edges (below).
    const directKeys = new Map<string, string>();
    const sameRelease = new Map<string, string[]>();
    for (const pkg of [...input.direct].sort((left, right) =>
      left.alias < right.alias ? -1 : 1,
    )) {
      if (!directKeys.has(pkg.purl)) directKeys.set(pkg.purl, pkg.alias);
      sameRelease.set(pkg.purl, [
        ...(sameRelease.get(pkg.purl) ?? []),
        pkg.alias,
      ]);
    }
    const keyOfNode = allocateLockKeys({
      selected: solved.selected,
      directKeys,
    });

    // Fetch every artifact at once (the pool's transport bounds how many are in
    // flight), then take the results in solve order, so what is locked and
    // which failure is reported do not depend on which download finished first.
    const artifacts = new Map<string, Promise<RegistryArtifact>>();
    for (const instance of solved.selected) {
      const exact = instance.identity.exactPurl;
      if (exact === undefined || directKeys.has(exact)) continue;
      const fetching = input.pool
        .optionsWithProvider(instance.identity.purlType)
        .then((options) =>
          resolveRegistryArtifact(instance.identity.purlType, exact, options),
        );
      // Reported where it is awaited below; this only keeps a later failure
      // from being an unhandled rejection while an earlier one is awaited.
      fetching.catch(() => undefined);
      artifacts.set(exact, fetching);
    }
    for (const instance of solved.selected) {
      const exact = instance.identity.exactPurl;
      if (exact === undefined || directKeys.has(exact)) continue;
      const alias = keyOfNode.get(instance.nodeId)!;
      // `inspect` describes a package; the downloadable artifact and its
      // published digest come from the artifact record, which is what the
      // direct path uses too.
      const artifact = await artifacts.get(exact)!;
      // Same standard as the direct path: the digest that goes in the lock is
      // re-derived from the bytes in hand, not copied from what the provider
      // said about them.
      const actual = digestOf(artifact.bytes);
      if (actual !== artifact.digest)
        throw new OpmError(
          'DIGEST_MISMATCH',
          `Registry digest mismatch for ${echoed(artifact.exactPurl)}: ` +
            `the ${echoed(instance.identity.purlType)} provider reported ${echoed(artifact.digest)}, ` +
            `the bytes hash to ${actual}`,
        );
      if (artifact.size > 0 && artifact.bytes.byteLength !== artifact.size)
        throw new OpmError(
          'SIZE_MISMATCH',
          `Registry size mismatch for ${echoed(artifact.exactPurl)}: ` +
            `expected ${artifact.size} bytes, got ${artifact.bytes.byteLength}`,
        );

      // A dependency nobody asked for directly is the case blockExoticSources
      // exists for, so it is evaluated at its real depth rather than skipped.
      // The facts are the real package's, whatever name an alias installs it
      // under: an alias is not a way past a gate.
      const facts = captureFactsFromSourceUri(
        artifact.exactPurl,
        artifact.uri,
        {
          evaluationTime,
          dependencyDepth: 1,
          fromRegistryArtifactRecord: true,
          lifecycleScriptsExecuted: false,
          lifecycle: instance.lifecycle,
          semanticLoss: instance.semanticLoss,
          sourceSnapshotDigests: instance.sourceSnapshots,
        },
      );
      facts.registryId = artifact.registryId;
      // The same publish-time evidence a direct package gets: a dependency
      // nobody asked for by name is the one a release-age window protects.
      await capturePublishTime(
        facts,
        await input.pool.provider(instance.identity.purlType),
        exact,
        { minimumReleaseAgeMinutes: policy.minimumReleaseAgeMinutes },
      );
      if (artifact.attestation !== undefined)
        applyAttestation(facts, artifact.attestation);
      try {
        await assertSupplyChainAllowed(policy, facts);
      } catch (error) {
        // Say who asked for it, and under what name: the refusal is about the
        // real package, and an alias is the reason it is in the closure.
        if (!(error instanceof OpmError)) throw error;
        const asked = solved.dependencyEdges.find(
          (edge) => edge.toNodeId === instance.nodeId,
        );
        const dependent = solved.selected.find(
          (item) => item.nodeId === asked?.fromNodeId,
        );
        if (asked === undefined || dependent === undefined) throw error;
        const own = purlPackageName(instance.identity.canonicalPurl);
        throw new OpmError(
          error.code,
          `${error.message} (${exact} is required by ${dependent.identity.exactPurl}` +
            `${asked.installName === own ? '' : ` as ${asked.installName}`})`,
          { cause: error },
        );
      }

      const transitiveIntegrity = nativeIntegrityOf(
        instance.identity.purlType,
        artifact.bytes,
      );
      const locked: LockPackage = {
        alias,
        purl: artifact.exactPurl,
        version: artifact.version || instance.nativeVersion || '0.0.0',
        digest: artifact.digest,
        size: artifact.bytes.byteLength,
        format: inferFormat(artifact.uri, artifact.mediaType),
        mediaType: artifact.mediaType,
        source: artifact.uri,
        storeKey: storeKeyFromDigest(artifact.digest),
        bins: binDeclarationsFromExecutables(artifact.bins),
        reason: 'transitive',
        ecosystem: instance.identity.purlType,
        ...(!(transitiveIntegrity === undefined) && {
          nativeIntegrity: transitiveIntegrity,
        }),
        ...lockPackageSupplyChainFields(facts),
        ...(artifact.attestation !== undefined && {
          attestation: lockAttestationFrom(artifact.attestation),
        }),
      };
      bindVerifiedArtifactBytes(locked, artifact.bytes, 'registry', facts);
      out[alias] = locked;
    }

    const instanceByNode = new Map<string, PackageInstance>(
      solved.selected.map((instance) => [instance.nodeId, instance]),
    );
    for (const instance of solved.selected) {
      const key = keyOfNode.get(instance.nodeId);
      if (key === undefined)
        throw new OpmError(
          'UNRESOLVABLE',
          `Selected package ${echoed(String(instance.identity.exactPurl))} has no unique lock entry`,
        );
      dependencies[key] ??= [];
    }
    for (const edge of solved.dependencyEdges) {
      const from = keyOfNode.get(edge.fromNodeId);
      const to = keyOfNode.get(edge.toNodeId);
      const target = instanceByNode.get(edge.toNodeId);
      if (from === undefined || to === undefined || target === undefined)
        throw new OpmError(
          'UNRESOLVABLE',
          'Selected dependency edge has no lock entry',
        );
      // The name a plain edge finds its target under is the target's own.
      if (edge.installName === purlPackageName(target.identity.canonicalPurl))
        dependencies[from]!.push(to);
      else (aliases[from] ??= {})[edge.installName] = to;
    }
    for (const key of Object.keys(dependencies))
      dependencies[key] = [...new Set(dependencies[key])].sort();
    for (const key of Object.keys(aliases))
      aliases[key] = Object.fromEntries(
        Object.entries(aliases[key]!).sort(([left], [right]) =>
          left < right ? -1 : 1,
        ),
      );
    // One release asked for under two names (`string-width` and
    // `string-width-cjs@npm:string-width`) is two directories with one package
    // each, and each needs what the release declares. Its edges were recorded
    // on the first entry; the others get the same, or they would resolve
    // whatever sits at the root, and survive no removal of the first.
    for (const [purl, first] of directKeys)
      for (const other of sameRelease.get(purl) ?? []) {
        if (other === first || dependencies[first] === undefined) continue;
        dependencies[other] = [...dependencies[first]];
        if (aliases[first] !== undefined)
          aliases[other] = { ...aliases[first] };
      }
  } catch (error) {
    // A closure that cannot be computed is an error, not a smaller lock. This
    // used to fall back to the direct set, which turned every failure here
    // (a wasm build that was not there, a solve the engine refused, a
    // dependency written as a git URL) into "Added vitest" and a lock of one
    // package, and left the install to find out which of its dependencies were
    // missing. The policy, digest and size refusals already propagated as they
    // were; the rest now say what stopped the closure.
    if (error instanceof OpmError && isClosureRefusal(error)) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new OpmError(
      error instanceof OpmError ? error.code : 'UNRESOLVABLE',
      `Cannot lock the dependency closure of ${resolvable.map((pkg) => echoed(pkg.purl)).join(', ')}: ${reason}${unresolvedNote(unresolved, gated)}`,
    );
  }
  return { packages: out, dependencies, aliases };
}

/** Refusals that were always errors: a mitigation must never read as advice. */
function isClosureRefusal(error: OpmError): boolean {
  return (
    error.code === 'POLICY_DENIED' ||
    error.code === 'POLICY_INDETERMINATE' ||
    error.code === 'DIGEST_MISMATCH' ||
    error.code === 'SIZE_MISMATCH'
  );
}

/** Who asked for a package, for a line of an error. */
function askedBy(requiredBy: readonly string[] | undefined): string {
  if (requiredBy === undefined || requiredBy.length === 0) return '';
  return ` (required by ${requiredBy.slice(0, 3).join(', ')}${requiredBy.length > 3 ? `, and ${requiredBy.length - 3} more` : ''})`;
}

/**
 * The candidates the walk had to set aside, and the ones the policy did, for an
 * error that follows from it.
 */
function unresolvedNote(
  unresolved: ResolvedGraph['unresolved'],
  gated: ResolvedGraph['gated'],
): string {
  const list = (items: ResolvedGraph['unresolved']) =>
    items
      .slice(0, 5)
      .map(
        (item) =>
          `\n  - ${echoed(item.purl)}: ${plainLine(item.reason)}${askedBy(item.requiredBy)}`,
      )
      .join('') +
    (items.length > 5 ? `\n  - and ${items.length - 5} more` : '');
  return (
    (unresolved.length === 0
      ? ''
      : `\nWhat the walk could not use:${list(unresolved)}`) +
    (gated.length === 0 ? '' : `\nWhat the policy set aside:${list(gated)}`)
  );
}
