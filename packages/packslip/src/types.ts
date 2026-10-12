import type { JsonObject } from './json.js';

/** `sigstore-oidc` is keyless (a CI identity); `sigstore-key` is a long-lived key. */
export type SignatureScheme = 'sigstore-oidc' | 'sigstore-key';

export type AttestedBy = 'vendor' | 'repackager';

export interface Subject {
  readonly name: string;
  readonly sha256: string;
  readonly sha512?: string;
}

/** A command on PATH: `path` is from the true archive root. */
export interface BinEntry {
  readonly path: string;
  /** The command as typed, without `.exe`. */
  readonly name: string;
}

export interface RequiredCommand {
  readonly name: string;
  readonly min?: string;
}

export interface HostRequirements {
  readonly osMin?: string;
  readonly glibcMin?: string;
  /** `[]` means inspected and none needed; absent means not checked. */
  readonly libs?: readonly string[];
  readonly bin?: readonly RequiredCommand[];
}

export interface Artifact {
  readonly name: string;
  readonly os?: string;
  readonly arch?: string;
  readonly libc?: string;
  readonly variant?: string;
  readonly size: number;
  readonly url?: string;
  readonly format: string;
  readonly bin?: readonly BinEntry[];
  readonly requires?: HostRequirements;
  readonly provenance?: readonly string[];
  readonly extensions?: JsonObject;
}

/** The four places a resource's content can come from. */
export type ResourceSource =
  | { readonly kind: 'archive'; readonly path: string }
  | { readonly kind: 'asset'; readonly name: string; readonly url?: string }
  | { readonly kind: 'repo'; readonly path: string }
  | {
      readonly kind: 'exec';
      readonly argv: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
    };

export interface Resource {
  /** `completion`, `man`, `cli-spec`, `skill`, `sbom`, `desktop`, `icon`, `app`, or a kind this consumer does not know. */
  readonly kind: string;
  /** Position in `predicate.resources`; ties between alternatives keep this order. */
  readonly index: number;
  readonly source: ResourceSource;
  readonly artifact?: string;
  readonly os?: string;
  readonly arch?: string;
  readonly libc?: string;
  readonly shell?: string;
  readonly shells?: readonly string[];
  readonly format?: string;
  readonly bin?: string;
  readonly name?: string;
  readonly extensions?: JsonObject;
}

export interface SourceInfo {
  readonly repo: string;
  readonly commit?: string;
  readonly tag?: string;
}

export interface Identity {
  readonly scheme: SignatureScheme;
  readonly keyId: string;
  readonly issuer?: string;
  /** `true` when absent: the signing workflow is pinned. */
  readonly pinWorkflow: boolean;
}

export interface Evidence {
  readonly kind: string;
  readonly detail?: string;
}

/** A decoded and structurally validated `release/v1` statement. */
export interface ReleaseStatement {
  readonly subjects: readonly Subject[];
  readonly project: string;
  readonly version: string;
  readonly publishedAt: string;
  readonly notesUrl?: string;
  readonly source?: SourceInfo;
  readonly artifacts: readonly Artifact[];
  readonly resources: readonly Resource[];
  readonly identity: Identity;
  readonly attestedBy: AttestedBy;
  readonly evidence: readonly Evidence[];
  readonly extensions?: JsonObject;
}

export interface ReleaseEntry {
  readonly version: string;
  readonly tag?: string;
  readonly publishedAt: string;
  /** URL of the release's bundle; the subject of that name carries its digest. */
  readonly packslip: string;
  readonly yanked: boolean;
  readonly statusReason?: string;
  readonly security: boolean;
  readonly evidence: readonly Evidence[];
  readonly extensions?: JsonObject;
}

/** A decoded and structurally validated `releases/v1` list. */
export interface ReleaseList {
  readonly subjects: readonly Subject[];
  readonly project: string;
  readonly generatedAt: string;
  readonly expiresAt: string;
  readonly sequence: number;
  readonly latest?: string;
  readonly identity: Identity;
  readonly releases: readonly ReleaseEntry[];
  readonly extensions?: JsonObject;
}

export const RELEASE_PREDICATE = 'https://packslip.dev/release/v1';
export const RELEASES_PREDICATE = 'https://packslip.dev/releases/v1';
export const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const PAYLOAD_TYPE = 'application/vnd.in-toto+json';
