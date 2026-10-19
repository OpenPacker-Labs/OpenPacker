/**
 * The key of a `snapshots` entry, and the value a dependency points at:
 * `name@version(peer suffix)`.
 *
 * ```
 * react-dom@18.2.0(react@18.2.0)                          one peer
 * @scope/a@1.0.0(b@2.0.0(c@3.0.0))(d@4.0.0)                nested peers, in groups
 * a@1.0.0(patch_hash=wbmb7dwhiv66et2i6bbymnlkhi)            a patched package
 * a@1.0.0(patch_hash=wbmb7dwhiv66et2i6bbymnlkhi)(b@2.0.0)   both
 * a@1.0.0(0f1e2d3c4b5a69788796a5b4c3d2e1f0)                peers too long to list: a hash
 * a@file:../a   a@https://host/a.tgz   a@git+https://host/a.git#<commit>
 * ```
 *
 * The split is pnpm's own (`indexOfDepPathSuffix` in `@pnpm/dependency-path`,
 * 10.28): the suffix is the run of balanced `(...)` groups at the very end, found
 * by walking back from the last `)`. This is stricter where pnpm is lenient:
 * parentheses that do not balance, an empty group, text after the suffix, or a
 * `(` inside the version are refused instead of being read as part of the
 * version, because a key that parses two ways is a key two tools install
 * differently.
 */

import { PnpmLockError } from './errors.js';
import { checkLimit, type PnpmLockLimits } from './limits.js';
import { redactAddresses } from './redact.js';
import {
  classifyVersion,
  packageNameProblem,
  type SourceKind,
} from './source.js';

/** `name@version(patch)(peers)`; a peer is itself a `DepPath`. */
export interface DepPath {
  /** The text this was read from. */
  readonly raw: string;
  readonly name: string;
  /** Everything between `name@` and the suffix: `1.2.3`, `file:../a`, `https://...`. */
  readonly version: string;
  readonly source: SourceKind;
  /** The `patch_hash=` group, without the group. */
  readonly patchHash?: string;
  /** The peers this was resolved against, in the order the key lists them. */
  readonly peers: readonly DepPath[];
  /** The 32 hex digits that stand for the peers when listing them would be too long. */
  readonly peersHash?: string;
}

const PATCH_HASH = /^[a-z0-9]{1,128}$/u;
const PEERS_HASH = /^[0-9a-f]{32}$/u;

interface Budget {
  readonly limits: PnpmLockLimits;
  readonly where: string;
  groups: number;
}

function refuse(budget: Budget, text: string, message: string): PnpmLockError {
  // Redacted before it is cut: a cut inside the user information would leave half of it.
  const shown = redactAddresses(text);
  return new PnpmLockError(
    'dep-path',
    `${JSON.stringify(shown.length > 120 ? `${shown.slice(0, 117)}...` : shown)} ${message}`,
    budget.where,
  );
}

/**
 * Where the run of balanced groups at the end of `rest` begins, or
 * `rest.length` when it does not end in `)`. pnpm's scan, but an unbalanced end
 * throws.
 */
function suffixStart(budget: Budget, rest: string): number {
  if (!rest.endsWith(')')) return rest.length;
  let depth = 0;
  for (let at = rest.length - 1; at >= 0; at -= 1) {
    const code = rest.charCodeAt(at);
    if (code === 0x29) depth += 1;
    else if (code === 0x28) {
      depth -= 1;
      if (depth < 0)
        throw refuse(budget, rest, 'opens a parenthesis it never closes');
    } else if (depth === 0) return at + 1;
  }
  if (depth !== 0)
    throw refuse(budget, rest, 'closes a parenthesis it never opened');
  return 0;
}

/** The text of each top-level `(...)` group of a suffix that is known to balance. */
function groupsOf(suffix: string): string[] {
  const groups: string[] = [];
  let depth = 0;
  let from = 0;
  for (let at = 0; at < suffix.length; at += 1) {
    const code = suffix.charCodeAt(at);
    if (code === 0x28) {
      if (depth === 0) from = at + 1;
      depth += 1;
    } else if (code === 0x29) {
      depth -= 1;
      if (depth === 0) groups.push(suffix.slice(from, at));
    }
  }
  return groups;
}

function parseAt(budget: Budget, text: string, nesting: number): DepPath {
  checkLimit(
    nesting,
    budget.limits.maxPeerDepth,
    'levels of nested peers',
    'maxPeerDepth',
    budget.where,
  );
  checkLimit(
    text.length,
    budget.limits.maxKeyLength,
    'characters in a dependency path',
    'maxKeyLength',
    budget.where,
  );
  const separator = text.indexOf('@', 1);
  if (separator === -1)
    throw refuse(budget, text, 'has no @ between the name and the version');
  const name = text.slice(0, separator);
  const nameProblem = packageNameProblem(name);
  if (nameProblem !== undefined)
    throw new PnpmLockError(
      'name',
      `${nameProblem} in ${JSON.stringify(text)}`,
      budget.where,
    );
  const rest = text.slice(separator + 1);
  const start = suffixStart(budget, rest);
  const version = rest.slice(0, start);
  if (version === '') throw refuse(budget, text, 'has no version');
  if (version.includes('(') || version.includes(')'))
    throw refuse(budget, text, 'has a parenthesis that is not a peer suffix');
  const kind = classifyVersion(version);
  if ('problem' in kind)
    throw refuse(budget, text, `has a version that ${kind.problem}`);

  let patchHash: string | undefined;
  let peersHash: string | undefined;
  const peers: DepPath[] = [];
  const groups = groupsOf(rest.slice(start));
  budget.groups += groups.length;
  checkLimit(
    budget.groups,
    budget.limits.maxPeerGroups,
    'peer groups in one dependency path',
    'maxPeerGroups',
    budget.where,
  );
  for (const [index, group] of groups.entries()) {
    if (group.startsWith('patch_hash=')) {
      const hash = group.slice('patch_hash='.length);
      if (index !== 0 || !PATCH_HASH.test(hash))
        throw refuse(
          budget,
          text,
          'has a patch_hash group that is not first or not a hash',
        );
      patchHash = hash;
    } else if (group.indexOf('@', 1) === -1) {
      if (
        !PEERS_HASH.test(group) ||
        groups.length !== index + 1 ||
        peers.length > 0
      )
        throw refuse(
          budget,
          text,
          `has the group (${group}), which is neither a peer nor the hash that replaces them`,
        );
      peersHash = group;
    } else {
      peers.push(parseAt(budget, group, nesting + 1));
    }
  }
  return {
    raw: text,
    name,
    version,
    source: kind.kind,
    ...(patchHash !== undefined && { patchHash }),
    peers,
    ...(peersHash !== undefined && { peersHash }),
  };
}

/** Read a `name@version(suffix)` key; `where` is the place in the lock it came from, for the message. */
export function parseDepPath(
  text: string,
  limits: PnpmLockLimits,
  where: string,
): DepPath {
  return parseAt({ limits, where, groups: 0 }, text, 0);
}

/** `name@version`: the key of this package in `packages`, with no suffix (pnpm's `removeSuffix`). */
export function packageKeyOf(path: DepPath): string {
  return `${path.name}@${path.version}`;
}

/** The text a `DepPath` reads from: the inverse of `parseDepPath`. */
export function formatDepPath(path: DepPath): string {
  const patch =
    path.patchHash === undefined ? '' : `(patch_hash=${path.patchHash})`;
  const peers =
    path.peersHash === undefined
      ? path.peers.map((peer) => `(${formatDepPath(peer)})`).join('')
      : `(${path.peersHash})`;
  return `${path.name}@${path.version}${patch}${peers}`;
}
