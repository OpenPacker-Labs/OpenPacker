import { parseProject, type Project } from './project.js';

/** What the verified signing certificate records about the repository. */
export interface CertificateRepository {
  /** Source Repository URI (Fulcio OID 1.3.6.1.4.1.57264.1.12). */
  readonly uri?: string;
  /** Source Repository Identifier (OID 1.3.6.1.4.1.57264.1.15). */
  readonly id?: string;
}

export interface ForgePin {
  /** The name of the release this pin was taken from. */
  readonly project: string;
  readonly repositoryId?: string;
}

export interface ForgeRelease {
  /** The project the verified statement names. */
  readonly project: string;
  /** The signing workflow's identity, without its ref. */
  readonly signer: string;
  readonly certificate: CertificateRepository;
}

export type ForgeRefusal = 'different-repository' | 'project-mismatch';

export type ForgeOutcome =
  | {
      readonly outcome: 'same' | 'renamed';
      /** The name the release was signed under, when it differs from the request. */
      readonly signedAs: string;
      /** Whether the signer's workflow path continues the previous signer's. */
      readonly signerContinues?: boolean;
    }
  | { readonly outcome: 'refuse'; readonly reason: ForgeRefusal };

/**
 * The workflow's path inside its repository, which is what signer continuity
 * compares: `.github/workflows/release.yml` in `jdx/rtx` continues as the same
 * workflow in `jdx/mise`. The ref (`@refs/tags/v1`) is not part of it.
 */
export function workflowPath(signer: string): string | undefined {
  const withoutRef = signer.includes('@')
    ? signer.slice(0, signer.indexOf('@'))
    : signer;
  const withoutScheme = withoutRef.replace(/^https:\/\//u, '');
  const slash = withoutScheme.indexOf('/');
  if (slash === -1) return undefined;
  const host = withoutScheme.slice(0, slash);
  const rest = withoutScheme.slice(slash + 1);
  if (host === 'gitlab.com') {
    // GitLab writes `<project path>//<file>`; the project path has any depth.
    const marker = rest.indexOf('//');
    return marker === -1 ? undefined : rest.slice(marker + 2);
  }
  const segments = rest.split('/');
  return segments.length > 2 ? segments.slice(2).join('/') : undefined;
}

function sameSubpath(left: Project, right: Project): boolean {
  return (
    left.forge === right.forge &&
    left.host === right.host &&
    left.subpath === right.subpath
  );
}

/**
 * Decide whether a verified release is the forge project a consumer asked for.
 *
 * A forge name can change hands, so the repository ID the certificate records
 * is the identity and the name only locates it. A remembered pin makes the
 * comparison exact; without an ID on either side there is only the name, and a
 * statement for any other name is refused.
 */
export function checkForge(
  pin: ForgePin | undefined,
  requested: string,
  release: ForgeRelease,
  previousSigner?: string,
): ForgeOutcome {
  const pinned = pin?.repositoryId;
  const certified = release.certificate.id;
  if (pinned !== undefined && certified !== undefined && pinned !== certified)
    return { outcome: 'refuse', reason: 'different-repository' };

  const signerContinues =
    previousSigner === undefined
      ? undefined
      : workflowPath(previousSigner) !== undefined &&
        workflowPath(previousSigner) === workflowPath(release.signer);
  const continuity = signerContinues === undefined ? {} : { signerContinues };

  if (release.project === requested)
    return { outcome: 'same', signedAs: release.project, ...continuity };

  // Another name is the same repository only if an ID on both sides says so.
  if (pinned === undefined || certified === undefined)
    return { outcome: 'refuse', reason: 'project-mismatch' };
  const wanted = parseProject(requested);
  const signed = parseProject(release.project);
  if (!sameSubpath(wanted, signed))
    return { outcome: 'refuse', reason: 'project-mismatch' };
  return { outcome: 'renamed', signedAs: release.project, ...continuity };
}
