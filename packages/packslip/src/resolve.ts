import {
  chooseRecommendation,
  rankCandidates,
  type Candidate,
} from './candidates.js';
import { discover, type Discovery, type ListMemory } from './discover.js';
import { checkDigest } from './download.js';
import { PackslipError, TrustChangeError } from './errors.js';
import type { Fetcher } from './fetch.js';
import { checkForge } from './forge.js';
import type { GithubEndpoints } from './github.js';
import type { DetectedHost } from './host.js';
import { forgeIssuer, parseProject, type Project } from './project.js';
import { MAX_BUNDLE_BYTES, parseSignedPayload } from './payload.js';
import { decodeReleaseList } from './release-list.js';
import { checkRequirements, type RequirementReport } from './requirements.js';
import { selectResources, type ResourceGroup } from './resources.js';
import { selectArtifact, type SelectionFallback } from './select.js';
import { decodeReleaseStatement } from './statement.js';
import { evaluateTrust, type TrustMemory } from './trust.js';
import type { Artifact, ReleaseList, ReleaseStatement } from './types.js';
import {
  verifyBundle,
  type SignerExpectation,
  type VerifiedBundle,
  type VerifyBundleInput,
} from './verify.js';
import type { VersionRequest } from './version.js';
import { shown } from './shown.js';

/** What the consumer has chosen to trust, never taken from a document. */
export interface SignerConfig {
  /** Signer fingerprints (`ps1_…`); the certificate's repository must match one. */
  readonly pins?: readonly string[];
  /** A pinned minisign public key, for key-signed projects. */
  readonly publicKey?: string;
  readonly identity?: string;
  readonly identityPrefix?: string;
  /** Defaults to the forge's issuer for a GitHub or GitLab project. */
  readonly issuer?: string;
  readonly sourceRepository?: string;
  /** Accept a key-signed bundle with no transparency-log entry. */
  readonly allowUnlogged?: boolean;
}

export interface ResolveInput {
  readonly project: Project;
  readonly request: VersionRequest;
  readonly signer: SignerConfig;
  /** What was accepted last time, to enforce signer continuity. */
  readonly memory?: TrustMemory;
  readonly listMemory?: ListMemory;
  /** Proposal ids a person approved. */
  readonly approvals?: readonly string[];
  readonly fetcher: Fetcher;
  readonly now: Date;
  readonly trustedRoot?: string;
  readonly host: DetectedHost;
  /** Formats the consumer can unpack, best first. */
  readonly formats: readonly string[];
  readonly variant?: string;
  readonly fallbacks?: readonly SelectionFallback[];
  /**
   * Skip releases younger than this, measured from a time the verifier
   * authenticated (a log entry's signed timestamp, or a timestamp authority).
   * A release with no authenticated time cannot be shown to be old enough and
   * is skipped like one that is too young.
   */
  readonly minimumReleaseAgeMs?: number;
  /** Install although the host does not meet a hard requirement. */
  readonly allowIncompatibleHost?: boolean;
  readonly endpoints?: GithubEndpoints;
}

export interface ResolvedRelease {
  readonly project: Project;
  readonly statement: ReleaseStatement;
  readonly verified: VerifiedBundle;
  readonly bundle: Uint8Array;
  readonly candidate: Candidate;
  readonly artifact: Artifact;
  readonly fallback?: SelectionFallback;
  readonly resources: readonly ResourceGroup[];
  readonly requirements: RequirementReport;
  /** What to remember from this release. */
  readonly memory: TrustMemory;
  /** Trust changes a person approved to get here. */
  readonly approvedChanges: readonly string[];
  readonly list?: { readonly sequence: number; readonly expiresAt: string };
  /** Things worth telling the user: a skipped recommendation, a fallback, a rename. */
  readonly notes: readonly string[];
}

function expectationFor(
  project: Project,
  config: SignerConfig,
): SignerExpectation {
  if (config.publicKey !== undefined)
    return { scheme: 'sigstore-key', publicKey: config.publicKey };
  const issuer = config.issuer ?? forgeIssuer(project.forge);
  if (issuer === undefined)
    throw new PackslipError(
      'INVALID_INPUT',
      `${project.name} lives on its own domain, so its signer cannot be derived from its name; ` +
        'configure a signer fingerprint, a public key, or an issuer with an identity',
    );
  const explicit =
    config.identity !== undefined ||
    config.identityPrefix !== undefined ||
    config.sourceRepository !== undefined ||
    (config.pins ?? []).length > 0;
  if (!explicit && project.forge === 'other')
    throw new PackslipError(
      'INVALID_INPUT',
      `${project.name} lives on its own domain, so its signer cannot be derived from its name; ` +
        'configure a signer fingerprint, a public key, or an issuer with an identity',
    );
  return {
    scheme: 'sigstore-oidc',
    issuer,
    ...(config.identity !== undefined && { identity: config.identity }),
    ...(config.identityPrefix !== undefined && {
      identityPrefix: config.identityPrefix,
    }),
    ...(config.sourceRepository !== undefined && {
      sourceRepository: config.sourceRepository,
    }),
    ...(config.pins !== undefined && { pins: config.pins }),
    ...(!explicit && { narrowedByForge: true }),
  };
}

function withoutRef(identity: string): string {
  const at = identity.indexOf('@');
  return at === -1 ? identity : identity.slice(0, at);
}

/**
 * The signer must be the one authorised to speak for the project asked for.
 * (That the statement's own declaration of its signer agrees with the key or
 * certificate that signed it is checked earlier, inside `verifyBundle`.)
 */
function checkSigner(
  requested: Project,
  statementProject: string,
  verified: VerifiedBundle,
  memory: TrustMemory | undefined,
  notes: string[],
): void {
  const signer = verified.signer;
  // A project on its own domain, or any key-signed project, is exactly the
  // project that was asked for: the consumer's pin is what ties the two.
  if (requested.forge === 'other' || signer.scheme === 'sigstore-key') {
    if (statementProject !== requested.name)
      throw new PackslipError(
        'PROJECT_MISMATCH',
        `The release is for ${shown(statementProject)}, not the requested ${requested.name}`,
      );
    return;
  }
  const named = parseProject(statementProject);
  const expectedUri = `https://${named.host}/${named.repository ?? ''}`;
  if (signer.repositoryUri !== undefined) {
    if (signer.repositoryUri.toLowerCase() !== expectedUri.toLowerCase())
      throw new PackslipError(
        'PROJECT_MISMATCH',
        `The certificate records source repository ${shown(signer.repositoryUri)}, but the statement names ${shown(statementProject)}`,
      );
  } else if (
    !signer.identity.toLowerCase().startsWith(`${expectedUri.toLowerCase()}/`)
  ) {
    throw new PackslipError(
      'PROJECT_MISMATCH',
      `The certificate names no source repository and the signer ${shown(signer.identity)} is not a workflow of ${shown(statementProject)}`,
    );
  }
  const outcome = checkForge(
    memory?.signer.repositoryId === undefined
      ? undefined
      : { project: memory.project, repositoryId: memory.signer.repositoryId },
    requested.name,
    {
      project: statementProject,
      signer: withoutRef(signer.identity),
      certificate: {
        ...(signer.repositoryUri !== undefined && {
          uri: signer.repositoryUri,
        }),
        ...(signer.repositoryId !== undefined && { id: signer.repositoryId }),
      },
    },
  );
  if (outcome.outcome === 'refuse')
    throw new PackslipError(
      outcome.reason === 'different-repository'
        ? 'SIGNER_MISMATCH'
        : 'PROJECT_MISMATCH',
      outcome.reason === 'different-repository'
        ? `${requested.name} is now served by a different repository than the one pinned (repository ID ${shown(signer.repositoryId ?? 'unknown')}); a recreated name is not the same project`
        : `The release is for ${shown(statementProject)}, which nothing shows is ${requested.name}`,
    );
  if (outcome.outcome === 'renamed')
    notes.push(
      `${requested.name} is now ${shown(statementProject)}; the repository ID matches the pinned one`,
    );
}

function memoryFrom(
  statement: ReleaseStatement,
  verified: VerifiedBundle,
): TrustMemory {
  const { signer } = verified;
  return {
    project: statement.project,
    signer: {
      scheme: signer.scheme,
      identity: signer.workflow ?? signer.identity,
      ...(signer.issuer !== undefined && { issuer: signer.issuer }),
      ...(signer.repositoryId !== undefined && {
        repositoryId: signer.repositoryId,
      }),
      ...(signer.keyHint !== undefined && { keyHint: signer.keyHint }),
      pinWorkflow: statement.identity.pinWorkflow,
    },
    attestedBy: statement.attestedBy,
    logged: verified.logged,
    provenance: statement.artifacts.some(
      (artifact) => (artifact.provenance?.length ?? 0) > 0,
    ),
  };
}

/**
 * How long ago the release is proven to have existed, or `undefined` when
 * nothing verified a time. Only a time the verifier vouched for counts: the
 * statement's `published_at` is the signer's own word, so a signer could
 * back-date it to walk through the gate it exists to enforce.
 */
function ageMs(verified: VerifiedBundle, now: Date): number | undefined {
  if (verified.integratedTime === undefined) return undefined;
  return now.getTime() - Date.parse(verified.integratedTime);
}

/** What discovery needs: the project, who may sign for it, and how to reach the network. */
export interface DiscoverRequest {
  readonly project: Project;
  readonly signer: SignerConfig;
  readonly memory?: TrustMemory;
  readonly listMemory?: ListMemory;
  readonly fetcher: Fetcher;
  readonly now: Date;
  readonly trustedRoot?: string;
  readonly endpoints?: GithubEndpoints;
}

export interface Discovered {
  readonly discovery: Discovery;
  /** Things worth telling the user, which resolution adds to. */
  readonly notes: string[];
  /** The verification settings, reused to verify a release's own bundle. */
  readonly verifyOptions: Omit<VerifyBundleInput, 'bundle'>;
}

/**
 * Find a project's releases, verifying its signed list if it has one. No
 * release bundle is verified here: discovery is a hint until the bundle behind
 * it checks out, and listing versions should not cost a download per version.
 */
export async function discoverReleases(
  input: DiscoverRequest,
): Promise<Discovered> {
  const { project } = input;
  const expectation = expectationFor(project, input.signer);
  const notes: string[] = [];
  const verifyOptions: Omit<VerifyBundleInput, 'bundle'> = {
    expectation,
    ...(input.trustedRoot !== undefined && { trustedRoot: input.trustedRoot }),
    ...(input.signer.allowUnlogged !== undefined && {
      allowUnlogged: input.signer.allowUnlogged,
    }),
  };
  const verifyList = (bundle: Uint8Array): ReleaseList => {
    const verified = verifyBundle({ bundle, ...verifyOptions });
    const list = decodeReleaseList(parseSignedPayload(verified.payload));
    checkSigner(project, list.project, verified, input.memory, notes);
    return list;
  };
  const discovery = await discover({
    project,
    fetcher: input.fetcher,
    now: input.now,
    verifyList,
    ...(input.listMemory !== undefined && { memory: input.listMemory }),
    ...(input.endpoints !== undefined && { endpoints: input.endpoints }),
  });
  return { discovery, notes, verifyOptions };
}

/**
 * Resolve a request to one verified release and the artifact to install.
 *
 * This is the consumer rules end to end: discover releases, rank them by the
 * specification's rules, fetch the best one's bundle, verify the signature
 * against a signer the *consumer* chose, check the statement is about the
 * project and version that were asked for, enforce signer continuity, select an
 * artifact for the host, and check what the host must provide.
 *
 * Nothing is installed. A verification failure is an error, never a reason to
 * try the next release: falling back is for releases that are absent or
 * ineligible, not for ones that are forged.
 */
export async function resolveRelease(
  input: ResolveInput,
): Promise<ResolvedRelease> {
  const { project, request } = input;
  const { discovery, notes, verifyOptions } = await discoverReleases(input);
  const recommendation = chooseRecommendation(
    discovery.signedLatest,
    discovery.githubLatest,
  );
  const ranking = rankCandidates(discovery.candidates, request, recommendation);
  if (ranking.skipped !== undefined)
    notes.push(
      `Skipped the ${ranking.skipped.recommendation.source === 'signed-list' ? 'vendor' : 'GitHub'}-recommended ${shown(ranking.skipped.recommendation.version)}: ${ranking.skipped.reason}`,
    );
  if (ranking.ordered.length === 0)
    throw new PackslipError(
      'NO_RELEASE',
      `${project.name} has no release matching "${request.spec}"` +
        `${request.prerelease || request.channel !== undefined ? '' : ' (prereleases are skipped unless requested)'}`,
    );

  const tooYoung: string[] = [];
  const untimed: string[] = [];
  for (const candidate of ranking.ordered) {
    const response = await input.fetcher.get(candidate.bundleUrl, {
      maxBytes: MAX_BUNDLE_BYTES,
    });
    if (response.status !== 200)
      throw new PackslipError(
        'UNAVAILABLE',
        `${shown(candidate.bundleUrl)} answered ${response.status} for ${project.name} ${shown(candidate.version)}`,
      );
    const bundle = response.bytes;
    if (candidate.bundleSha256 !== undefined)
      checkDigest(
        { name: candidate.bundleUrl, sha256: candidate.bundleSha256 },
        bundle,
      );
    const verified = verifyBundle({ bundle, ...verifyOptions });
    const statement = decodeReleaseStatement(
      parseSignedPayload(verified.payload),
    );
    if (statement.version !== candidate.version)
      throw new PackslipError(
        'PROJECT_MISMATCH',
        `${shown(candidate.tag ?? candidate.bundleUrl)} names version ${shown(candidate.version)}, but the signed release is ${shown(statement.version)}`,
      );
    checkSigner(project, statement.project, verified, input.memory, notes);

    const observed = memoryFrom(statement, verified);
    const decision = evaluateTrust(
      project.name,
      input.memory,
      observed,
      input.approvals ?? [],
    );
    if (!decision.accepted)
      throw new TrustChangeError(
        decision.proposal.id,
        project.name,
        decision.proposal.changes.map((change) => change.message),
      );

    if (input.minimumReleaseAgeMs !== undefined) {
      const age = ageMs(verified, input.now);
      if (age === undefined) {
        untimed.push(candidate.version);
        continue;
      }
      if (age < input.minimumReleaseAgeMs) {
        tooYoung.push(candidate.version);
        continue;
      }
    }

    const selected = selectArtifact(statement.artifacts, {
      host: input.host.platform,
      ...(input.variant !== undefined && { variant: input.variant }),
      formats: input.formats,
      ...(input.fallbacks !== undefined && { fallbacks: input.fallbacks }),
    });
    if (selected.fallback !== undefined)
      notes.push(
        `No exact build for this host; using ${shown(selected.artifact.name)} (${selected.fallback})`,
      );
    const requirements = checkRequirements(selected.artifact, input.host.facts);
    if (
      requirements.refusals.length > 0 &&
      input.allowIncompatibleHost !== true
    )
      throw new PackslipError(
        'HOST_INCOMPATIBLE',
        `${shown(selected.artifact.name)} cannot run here:`,
        requirements.refusals,
      );
    return {
      project,
      statement,
      verified,
      bundle,
      candidate,
      artifact: selected.artifact,
      ...(selected.fallback !== undefined && { fallback: selected.fallback }),
      resources: selectResources(statement, selected.artifact),
      requirements,
      memory: decision.memory,
      approvedChanges: decision.approved.map((change) => change.message),
      ...(discovery.list !== undefined && { list: discovery.list }),
      notes,
    };
  }
  const reasons = [
    tooYoung.length > 0
      ? `younger than the minimum release age (${tooYoung.join(', ')})`
      : undefined,
    untimed.length > 0
      ? `without a verified signing time, so their age cannot be shown (${untimed.join(', ')})`
      : undefined,
  ].filter((reason) => reason !== undefined);
  throw new PackslipError(
    'NO_RELEASE',
    `Every release of ${project.name} matching "${request.spec}" is ${reasons.join(' or ')}`,
  );
}
