import type {
  PackageInstance,
  Requirement,
  TargetPredicate,
} from '@openpacker/contracts';
import type { CatalogProvider } from '@openpacker/adapter-core';
import { OpmError } from './types.js';
import { ecosystemFromPurl, stripPurlVersion } from './spec.js';
import { ProviderPool, type RegistryOptions } from './registry.js';
import { codecFor } from './codecs.js';
import { isChangedUnderTheResolve } from './registry-changed.js';
import { INSTALLED_KINDS } from './closure-edges.js';
import {
  isAliasRequirement,
  isBundledRequirement,
  nativeRange,
  requirementTag,
} from './requirement-info.js';
import {
  detectNativeTarget,
  evaluateTargetPredicate,
  type NativeTarget,
} from './host-target.js';

/**
 * Transitive dependency resolution.
 *
 * `opm` resolved direct requirements only: a lockfile listed what you asked
 * for and nothing it needed. This walks the graph, gathers candidate versions
 * for every package reachable from the roots, and hands the result to the
 * PREX solver — the proof-checked CDCL engine this repository is built around
 * and which nothing in `opm` called.
 *
 * Candidate discovery is bounded, and says so. A universe containing every
 * published version of every transitive dependency is neither buildable in
 * reasonable time nor necessary: the newest versions satisfying a constraint
 * are the ones a solve will pick from in practice. When the bound truncates a
 * candidate set that is recorded, because a solve over a truncated universe
 * can report unsatisfiable for a problem that is actually satisfiable, and the
 * difference matters.
 *
 * Native ranges are read from each ecosystem's own encoding (npm `range`,
 * PyPI `specifier`, …) rather than only from a single field name. Environment
 * markers on optional requirements are evaluated against an explicit host
 * profile for *this* resolve — adapters still refuse to claim marker truth in
 * translated metadata; evaluation is a resolve-time decision, not a capture
 * one.
 */

/**
 * Losses that say a package-level target predicate could not be expressed and
 * so was applied to artifacts only. The walk evaluates that predicate against
 * the host of this resolve, which is the evidence the loss asked for.
 */
const HOST_EVALUATED_LOSS_CODES = new Set([
  'NPM_PACKAGE_TARGET_PREDICATE_ARTIFACT_ONLY',
]);

export interface ResolutionBounds {
  /** Newest candidates kept per package. */
  candidatesPerPackage?: number;
  /** Distinct packages the walk may visit. */
  maximumPackages?: number;
}

const DEFAULT_BOUNDS: Required<ResolutionBounds> = {
  candidatesPerPackage: 6,
  // A typical application's closure is hundreds of packages and a large one
  // over a thousand; 256 stopped the former. It is a ceiling on distinct
  // packages (not on requirement edges), so it bounds the work and not the
  // fan-in.
  maximumPackages: 2048,
};

/**
 * Host facts used to decide marker-gated requirements for this resolve.
 *
 * Defaults come from the running process. Callers can override for a known
 * target (cross-compile, CI image) without re-running on that host.
 */
export interface HostEnvironment {
  /** PEP 440 public version of the Python interpreter, e.g. `3.12`. */
  pythonVersion: string;
  /** `sys.platform` value: `linux`, `darwin`, `win32`, … */
  sysPlatform: string;
  /** `os.name` value: `posix` or `nt`. */
  osName: 'posix' | 'nt';
  /** `platform.system()` value: `Linux`, `Darwin`, `Windows`, … */
  platformSystem: string;
  /** Requested extras; empty means a bare install. */
  extras: ReadonlySet<string>;
  /** The machine in npm's vocabulary, for `os`/`cpu`/`libc` predicates. */
  nativeTarget: NativeTarget;
}

export function defaultHostEnvironment(
  overrides: Partial<HostEnvironment> = {},
): HostEnvironment {
  const platform =
    process.platform === 'win32'
      ? 'win32'
      : process.platform === 'darwin'
        ? 'darwin'
        : 'linux';
  return {
    pythonVersion:
      overrides.pythonVersion ??
      process.env.OPM_PYTHON_VERSION?.trim() ??
      process.versions?.python?.split('.').slice(0, 2).join('.') ??
      // Node does not embed a Python version. Default to a current stable so
      // marker-gated deps that gate on modern Python are not silently dropped
      // on a host that has no interpreter of its own in-process.
      '3.12',
    sysPlatform: overrides.sysPlatform ?? platform,
    osName: overrides.osName ?? (process.platform === 'win32' ? 'nt' : 'posix'),
    platformSystem:
      overrides.platformSystem ??
      (process.platform === 'win32'
        ? 'Windows'
        : process.platform === 'darwin'
          ? 'Darwin'
          : 'Linux'),
    extras: overrides.extras ?? new Set(),
    nativeTarget: overrides.nativeTarget ?? detectNativeTarget(),
  };
}

export interface ResolvedGraph {
  /** Every candidate instance discovered, ready to become a universe. */
  packages: PackageInstance[];
  /** Root requirements, as exact or ranged PURLs. */
  roots: string[];
  /** Packages whose candidate list hit the bound. */
  truncated: string[];
  /**
   * Packages reachable but not resolvable, with the reason and, where an edge
   * asked for them, who did.
   */
  unresolved: { purl: string; reason: string; requiredBy?: string[] }[];
  /** Marker-gated requirements skipped because the host marker is false. */
  skippedMarkers: { purl: string; marker: string }[];
  /** Optional dependencies left out because this host is not one they run on. */
  skippedPlatform: { purl: string; reason: string }[];
  /** Candidates the caller's gate left out, with its reason and who asked. */
  gated: { purl: string; reason: string; requiredBy?: string[] }[];
}

export { nativeRange };

/** Marker string attached to a requirement, if any. */
export function requirementMarker(requirement: unknown): string | undefined {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const value = requirement as {
    nativeSemantics?: { data?: { marker?: unknown } };
    raw?: unknown;
  };
  const fromData = value.nativeSemantics?.data?.marker;
  if (typeof fromData === 'string' && fromData.trim() !== '')
    return fromData.trim();
  if (typeof value.raw === 'string' && value.raw.includes(';')) {
    const marker = value.raw.slice(value.raw.indexOf(';') + 1).trim();
    if (marker !== '') return marker;
  }
  return undefined;
}

/**
 * Evaluate a PEP 508 environment marker against a host profile.
 *
 * Supports the atoms that dominate `requires_dist` in practice:
 * `python_version`, `sys_platform`, `os_name`, `platform_system`, and
 * `extra`, combined with `and` / `or` and parentheses. Anything outside that
 * subset returns `'unknown'` so the walk can refuse to invent an answer.
 */
export function evaluateEnvironmentMarker(
  marker: string,
  env: HostEnvironment,
): boolean | 'unknown' {
  try {
    return evalMarkerExpr(marker.trim(), env);
  } catch {
    return 'unknown';
  }
}

function evalMarkerExpr(
  expr: string,
  env: HostEnvironment,
): boolean | 'unknown' {
  const trimmed = expr.trim();
  if (trimmed === '') return true;

  // Split on top-level `or`, then `and`.
  const orParts = splitTopLevel(trimmed, 'or');
  if (orParts.length > 1) {
    let sawUnknown = false;
    for (const part of orParts) {
      const result = evalMarkerExpr(part, env);
      if (result === true) return true;
      if (result === 'unknown') sawUnknown = true;
    }
    return sawUnknown ? 'unknown' : false;
  }

  const andParts = splitTopLevel(trimmed, 'and');
  if (andParts.length > 1) {
    let sawUnknown = false;
    for (const part of andParts) {
      const result = evalMarkerExpr(part, env);
      if (result === false) return false;
      if (result === 'unknown') sawUnknown = true;
    }
    return sawUnknown ? 'unknown' : true;
  }

  if (trimmed.startsWith('(') && trimmed.endsWith(')'))
    return evalMarkerExpr(trimmed.slice(1, -1), env);

  return evalMarkerAtom(trimmed, env);
}

function splitTopLevel(expr: string, keyword: 'and' | 'or'): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuote: '"' | "'" | null = null;
  let start = 0;
  const pattern = keyword === 'and' ? /\band\b/giu : /\bor\b/giu;
  let match: RegExpExecArray | null;
  // Manual scan so quotes and parentheses are respected.
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i]!;
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    pattern.lastIndex = i;
    match = pattern.exec(expr);
    if (match && match.index === i) {
      parts.push(expr.slice(start, i));
      i = match.index + match[0].length - 1;
      start = i + 1;
    }
  }
  if (parts.length === 0) return [expr];
  parts.push(expr.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function evalMarkerAtom(
  atom: string,
  env: HostEnvironment,
): boolean | 'unknown' {
  const match =
    /^(python_version|python_full_version|sys_platform|os_name|platform_system|extra)\s*(<=|>=|==|!=|<|>)\s*(['"])(.*?)\3$/u.exec(
      atom.trim(),
    );
  if (!match) return 'unknown';
  const variable = match[1];
  const op = match[2];
  const literal = match[4];
  if (variable === undefined || op === undefined || literal === undefined)
    return 'unknown';

  if (variable === 'extra') {
    if (op === '==') return env.extras.has(literal);
    if (op === '!=') return !env.extras.has(literal);
    return 'unknown';
  }

  const left =
    variable === 'python_version' || variable === 'python_full_version'
      ? env.pythonVersion
      : variable === 'sys_platform'
        ? env.sysPlatform
        : variable === 'os_name'
          ? env.osName
          : env.platformSystem;

  if (variable === 'python_version' || variable === 'python_full_version') {
    return compareDotted(left, literal, op);
  }

  switch (op) {
    case '==':
      return left === literal;
    case '!=':
      return left !== literal;
    default:
      return 'unknown';
  }
}

function compareDotted(
  left: string,
  right: string,
  op: string,
): boolean | 'unknown' {
  const a = left.split('.').map((part) => Number.parseInt(part, 10));
  const b = right.split('.').map((part) => Number.parseInt(part, 10));
  if (a.some((n) => Number.isNaN(n)) || b.some((n) => Number.isNaN(n)))
    return 'unknown';
  const len = Math.max(a.length, b.length);
  let cmp = 0;
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av < bv) {
      cmp = -1;
      break;
    }
    if (av > bv) {
      cmp = 1;
      break;
    }
  }
  switch (op) {
    case '==':
      return cmp === 0;
    case '!=':
      return cmp !== 0;
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
    case '>':
      return cmp > 0;
    case '>=':
      return cmp >= 0;
    default:
      return 'unknown';
  }
}

/** How the walk treats one requirement. */
export interface FollowDecision {
  follow: boolean;
  skipReason?: string;
  /**
   * `optional` when the edge is followed on condition of the dependency itself
   * (npm's optionalDependencies: installed where the dependency runs). The
   * condition cannot be read from the edge, so the walk decides it once it has
   * inspected the dependency.
   */
  via?: 'optional';
}

/** The kind of specifier a requirement carries, when it is not a version range. */
function nativeSpecKind(requirement: unknown): string | undefined {
  // SAFETY: only the optional `specKind` of the adapter's native data is read.
  const value = requirement as {
    nativeSemantics?: { data?: { specKind?: unknown } };
  };
  const kind = value.nativeSemantics?.data?.specKind;
  return typeof kind === 'string' ? kind : undefined;
}

/**
 * Whether a requirement should be followed during the install walk.
 *
 * Hard requirements always are. Optional ones are followed only when they
 * carry an environment marker that evaluates to true for this host — that is
 * how PyPI encodes "required on this platform" without making every marker a
 * hard edge on every host. npm's `optionalDependencies` are followed where the
 * dependency runs (see `FollowDecision.via`). A specifier that is not a version
 * range (a git URL, a bare dist-tag) is never followed: reading it as the
 * registry's package of that name is how dependency confusion lands. An `npm:`
 * alias is followed as a requirement on its target, which the adapter named.
 */
export function shouldFollowRequirement(
  requirement: Requirement,
  env: HostEnvironment,
): FollowDecision {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const kind = (requirement as { kind?: string }).kind ?? 'runtime';
  if (!INSTALLED_KINDS.has(kind))
    return { follow: false, skipReason: `kind ${kind} is not installed` };

  // A dependency the package ships inside its own archive is installed with it,
  // and never resolved.
  if (isBundledRequirement(requirement))
    return {
      follow: false,
      skipReason: 'bundled: it ships inside the package archive',
    };
  const specKind = nativeSpecKind(requirement);
  // An alias names its target explicitly, so a dist-tag on it is the target's
  // tag; a bare dist-tag is not read as anything.
  const aliasedTag =
    specKind === 'tag' && requirementTag(requirement) !== undefined
      ? isAliasRequirement(requirement)
      : false;
  if (specKind !== undefined && specKind !== 'range' && !aliasedTag)
    return {
      follow: false,
      skipReason: `specifier is a ${specKind}, not a registry version range`,
    };

  if (kind === 'optional') return { follow: true, via: 'optional' };

  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const optional = (requirement as { optional?: boolean }).optional === true;
  const marker = requirementMarker(requirement);

  if (!optional) return { follow: true };

  if (marker === undefined)
    return { follow: false, skipReason: 'optional without marker' };

  const result = evaluateEnvironmentMarker(marker, env);
  if (result === true) return { follow: true };
  if (result === false)
    return { follow: false, skipReason: `marker false: ${marker}` };
  return {
    follow: false,
    skipReason: `marker not evaluable: ${marker}`,
  };
}

/**
 * Versions of `basePurl` that satisfy `range`, newest first.
 *
 * Matching uses the ecosystem's own codec rather than a translated constraint.
 * The npm codec already records `NATIVE_RANGE_NOT_EXACTLY_REPRESENTABLE` when
 * a range has no exact VERS form, so resolving through VERS would resolve
 * through a known approximation when the exact semantics are available.
 */
async function candidatesFor(
  ecosystem: string,
  basePurl: string,
  range: string | undefined,
  provider: CatalogProvider,
): Promise<string[]> {
  const published = await provider.enumerate(basePurl);
  // `*` takes every version, except that npm's does not take a prerelease.
  if (
    range === undefined ||
    range === '' ||
    (range === '*' && ecosystem !== 'npm')
  )
    return [...published].reverse();

  const codec = codecFor(ecosystem);
  const satisfying: string[] = [];
  for (const purl of published) {
    const version = purl.slice(purl.lastIndexOf('@') + 1);
    try {
      if (codec.satisfies(decodeURIComponent(version), range))
        satisfying.push(purl);
    } catch {
      // A range this codec cannot parse is not a reason to drop a candidate
      // silently; it is kept and the solver decides.
      satisfying.push(purl);
    }
  }
  return satisfying.reverse();
}

/**
 * Whether a candidate runs on the host this resolve is for.
 *
 * `true` for a package that states no platform, `'unknown'` for a predicate
 * this cannot evaluate. Only npm's `os`/`cpu`/`libc` are evaluated: they are
 * stored in npm's own vocabulary, which is what the native target is in.
 */
function hostSupport(
  instance: PackageInstance,
  host: HostEnvironment,
): boolean | 'unknown' {
  if (instance.identity.purlType !== 'npm') return true;
  const predicate = hostPredicateOf(instance);
  if (predicate === undefined) return true;
  return evaluateTargetPredicate(predicate, host.nativeTarget);
}

function describeTarget(target: NativeTarget): string {
  return [
    `os=${target.os}`,
    `architecture=${target.architecture}`,
    ...(target.libc === undefined ? [] : [`libc=${target.libc}`]),
  ].join(' ');
}

/**
 * The candidate with the platform loss marked as met, once the predicate it
 * says was not evaluated has been evaluated for this host.
 */
function withHostEvaluated(
  instance: PackageInstance,
  host: HostEnvironment,
): PackageInstance {
  if (
    !instance.semanticLoss.some((loss) =>
      HOST_EVALUATED_LOSS_CODES.has(loss.code),
    )
  )
    return instance;
  return {
    ...instance,
    semanticLoss: instance.semanticLoss.map((loss) =>
      HOST_EVALUATED_LOSS_CODES.has(loss.code)
        ? {
            ...loss,
            severity: 'warning' as const,
            mitigation: `Evaluated against the host of this resolve (${describeTarget(host.nativeTarget)}) and satisfied`,
          }
        : loss,
    ),
  };
}

interface QueueItem {
  purl: string;
  range?: string;
  /** `range` names a dist-tag of the package, which the registry resolves. */
  tag?: boolean;
  via: 'hard' | 'optional';
  /** Who asked for it, for a message when nothing answers. */
  by: Set<string>;
}

/** A requirement that named a dist-tag, to be pinned once the tag is read. */
interface TagEdge {
  requirement: Requirement;
  base: string;
  ecosystem: string;
  tag: string;
}

/** A provider that can say which version a dist-tag points at. */
interface TagSource {
  resolveTag(basePurl: string, tag: string): Promise<string | undefined>;
}

function canResolveTags(
  provider: CatalogProvider,
): provider is CatalogProvider & TagSource {
  return (
    'resolveTag' in provider &&
    typeof (provider as { resolveTag?: unknown }).resolveTag === 'function'
  );
}

/** What the registry said about one candidate version. */
type CandidateOutcome =
  | { kind: 'error'; reason: string }
  | { kind: 'gated'; reason: string }
  | {
      kind: 'ok';
      instance: PackageInstance;
      host: boolean | 'unknown';
    };

/** What reading for a queue item found; the walk applies it in queue order. */
type PreparedItem =
  | { failure: string }
  | {
      candidates: string[];
      bounded: boolean;
      found: CandidateOutcome[];
      /** For a dist-tag item: the exact version the tag points at. */
      resolvedTag?: string;
    };

/**
 * Walk from the root requirements to every package they need.
 *
 * Breadth-first, so the shallowest constraint on a package is seen first and
 * the bound truncates the deepest candidates rather than the most relevant
 * ones.
 *
 * Optional dependencies (npm's optionalDependencies) are followed only to
 * candidates that run on this host, and the edge to them is made hard, because
 * that is what an install does: the platform-specific binary a native package
 * ships as `pkg-linux-x64-gnu` is installed and its siblings are not. A hard
 * dependency that does not run on this host is refused, as npm refuses it.
 */
export async function resolveGraph(input: {
  roots: readonly { purl: string; range?: string }[];
  bounds?: ResolutionBounds;
  options?: RegistryOptions;
  optionsFor?: (ecosystem: string) => RegistryOptions;
  host?: HostEnvironment;
  /** Providers shared with the steps after the walk; one is made if absent. */
  pool?: ProviderPool;
  /**
   * Leaves a candidate out of the universe, with the reason, before it is
   * inspected. The walk offers every candidate to it, newest first, and it is
   * how a release the policy would refuse is passed over for the previous one
   * that satisfies the same range.
   */
  candidateGate?: (
    exactPurl: string,
    provider: CatalogProvider,
  ) => Promise<string | undefined>;
}): Promise<ResolvedGraph> {
  const bounds = { ...DEFAULT_BOUNDS, ...input.bounds };
  const options = input.options ?? {};
  const host = input.host ?? defaultHostEnvironment();
  const pool =
    input.pool ??
    new ProviderPool((ecosystem) => input.optionsFor?.(ecosystem) ?? options);
  const packages: PackageInstance[] = [];
  const truncated: string[] = [];
  const unresolved: ResolvedGraph['unresolved'] = [];
  const skippedMarkers: { purl: string; marker: string }[] = [];
  const skippedPlatform: { purl: string; reason: string }[] = [];
  const gated: ResolvedGraph['gated'] = [];
  const reported = new Set<string>();
  const expanded = new Set<string>();
  const queued = new Map<string, QueueItem>();
  const discovered = new Set<string>();
  /** Edges that named a dist-tag, pinned to its version once it is read. */
  const tagEdges: TagEdge[] = [];
  /** `base|tag` → the version the registry says the tag points at. */
  const resolvedTags = new Map<string, string>();
  /** An unresolved entry and the item it came from, to name who asked. */
  const askedFor: {
    entry: { purl: string; reason: string; requiredBy?: string[] };
    item: QueueItem;
  }[] = [];
  const unresolve = (
    item: QueueItem,
    entry: Omit<ResolvedGraph['unresolved'][number], 'requiredBy'>,
  ) => {
    const recorded = { ...entry };
    unresolved.push(recorded);
    askedFor.push({ entry: recorded, item });
  };
  /** Optional edges, made hard afterwards if their target was admitted. */
  const optionalEdges: {
    requirement: Requirement;
    base: string;
    ecosystem: string;
  }[] = [];

  const keyOf = (item: QueueItem) =>
    `${item.purl}|${item.tag === true ? 'tag:' : ''}${item.range ?? ''}|${item.via}`;
  // Start reading a package's metadata as soon as something asks for it, not
  // when the walk gets to it. Nothing is read that the walk would not read
  // anyway.
  const warmed = new Set<string>();
  const warm = (purl: string) => {
    if (warmed.has(purl)) return;
    warmed.add(purl);
    const ecosystem = ecosystemFromPurl(purl);
    pool
      .provider(ecosystem)
      .then((provider) => provider.enumerate(purl))
      .catch(() => undefined);
  };

  // What the registry says about a candidate, asked once however many ranges
  // reach it.
  const outcomes = new Map<string, Promise<CandidateOutcome>>();
  const outcomeOf = (candidate: string, provider: CatalogProvider) => {
    let outcome = outcomes.get(candidate);
    if (outcome === undefined) {
      outcome = (async (): Promise<CandidateOutcome> => {
        try {
          const refusal = await input.candidateGate?.(candidate, provider);
          if (refusal !== undefined) return { kind: 'gated', reason: refusal };
          const instance = (await provider.inspect(candidate)).package;
          return { kind: 'ok', instance, host: hostSupport(instance, host) };
        } catch (error) {
          if (isChangedUnderTheResolve(error)) throw error;
          return {
            kind: 'error',
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      })();
      outcomes.set(candidate, outcome);
    }
    return outcome;
  };

  // The part of an item that only reads. A level of the walk does this for all
  // its items together; what each finds is then applied in queue order, so the
  // graph does not depend on which read finished first.
  const prepare = async (item: QueueItem): Promise<PreparedItem> => {
    const ecosystem = ecosystemFromPurl(item.purl);
    try {
      const provider = await pool.provider(ecosystem);
      if (item.tag === true) {
        if (!canResolveTags(provider))
          return {
            failure: `this ${ecosystem} registry cannot say which version the dist-tag "${item.range}" points at`,
          };
        const exact = await provider.resolveTag(item.purl, item.range!);
        if (exact === undefined)
          return {
            failure: `the package has no dist-tag "${item.range}"`,
          };
        const found = [await outcomeOf(exact, provider)];
        return {
          candidates: [exact],
          bounded: false,
          found,
          resolvedTag: exact.slice(exact.lastIndexOf('@') + 1),
        };
      }
      let candidates = await candidatesFor(
        ecosystem,
        item.purl,
        item.range,
        provider,
      );
      const bounded = candidates.length > bounds.candidatesPerPackage;
      if (bounded)
        candidates = candidates.slice(0, bounds.candidatesPerPackage);
      const found = await Promise.all(
        candidates.map((candidate) => outcomeOf(candidate, provider)),
      );
      return { candidates, bounded, found };
    } catch (error) {
      if (isChangedUnderTheResolve(error)) throw error;
      return {
        failure: error instanceof Error ? error.message : String(error),
      };
    }
  };

  let queue: QueueItem[] = input.roots.map((root) => ({
    purl: stripPurlVersion(root.purl),
    via: 'hard' as const,
    by: new Set(['the project']),
    ...(!(root.range === undefined) && { range: root.range }),
  }));
  for (const item of queue) {
    queued.set(keyOf(item), item);
    warm(item.purl);
  }

  while (queue.length > 0) {
    const level = queue;
    queue = [];
    const prepared = await Promise.all(level.map(prepare));
    for (const [position, item] of level.entries()) {
      discovered.add(item.purl);
      if (discovered.size > bounds.maximumPackages)
        throw new OpmError(
          'UNRESOLVABLE',
          `Dependency graph exceeded ${bounds.maximumPackages} packages. ` +
            `Raise the bound deliberately rather than resolving an unbounded graph.`,
        );
      const ready = prepared[position]!;
      if ('failure' in ready) {
        unresolve(item, { purl: item.purl, reason: ready.failure });
        continue;
      }
      const { candidates, found } = ready;
      if (candidates.length === 0) {
        unresolve(item, {
          purl: item.purl,
          reason:
            item.range === undefined
              ? 'the registry published no versions'
              : `no published version satisfies ${item.range}`,
        });
        continue;
      }
      if (ready.bounded) truncated.push(item.purl);
      if (ready.resolvedTag !== undefined)
        resolvedTags.set(`${item.purl}|${item.range}`, ready.resolvedTag);

      let admitted = 0;
      for (const [index, candidate] of candidates.entries()) {
        const outcome = found[index]!;
        if (outcome.kind !== 'ok') {
          if (!reported.has(candidate)) {
            reported.add(candidate);
            if (outcome.kind === 'gated') {
              const recorded = { purl: candidate, reason: outcome.reason };
              gated.push(recorded);
              askedFor.push({ entry: recorded, item });
            } else unresolve(item, { purl: candidate, reason: outcome.reason });
          }
          continue;
        }
        const { instance } = outcome;

        if (outcome.host === false) {
          const reason = `does not run on this host (${describeTarget(host.nativeTarget)})`;
          if (item.via === 'optional')
            skippedPlatform.push({ purl: candidate, reason });
          else unresolve(item, { purl: candidate, reason });
          continue;
        }
        // An optional dependency whose platform cannot be established is left
        // out rather than guessed in; a hard one is kept and the solver decides.
        if (outcome.host === 'unknown' && item.via === 'optional') {
          skippedPlatform.push({
            purl: candidate,
            reason: 'its platform restriction could not be evaluated',
          });
          continue;
        }
        admitted += 1;
        if (expanded.has(candidate)) continue;
        expanded.add(candidate);

        // Requirements whose markers are true for this host become hard edges
        // for the solver. Adapters leave them `optional: true` so capture does
        // not invent host truth; resolve is the place that decides.
        const decisions = new Map<Requirement, FollowDecision>();
        const requirements = (instance.requirements ?? []).map(
          (requirement) => {
            const decision = shouldFollowRequirement(requirement, host);
            const copy = { ...requirement };
            if (decision.follow && decision.via === undefined)
              copy.optional = false;
            decisions.set(copy, decision);
            return copy;
          },
        );
        const evaluated =
          outcome.host === true && hostPredicateOf(instance) !== undefined
            ? withHostEvaluated(instance, host)
            : instance;
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        packages.push({ ...evaluated, requirements } as PackageInstance);

        for (const requirement of requirements) {
          const decision = decisions.get(requirement)!;
          // SAFETY: The surrounding boundary establishes the asserted domain contract.
          const expression = (requirement as { expression?: { purl?: string } })
            .expression;
          if (!decision.follow) {
            const marker = requirementMarker(requirement);
            if (
              marker !== undefined &&
              decision.skipReason?.startsWith('marker false')
            ) {
              if (expression?.purl)
                skippedMarkers.push({ purl: expression.purl, marker });
            }
            // Marker unknown: surface so a silent empty graph is not the only
            // signal that something was skipped.
            if (decision.skipReason?.startsWith('marker not evaluable')) {
              if (expression?.purl)
                unresolved.push({
                  purl: expression.purl,
                  reason: decision.skipReason,
                  requiredBy: [candidate],
                });
            }
            continue;
          }
          if (!expression?.purl) continue;
          const range = nativeRange(requirement);
          const tag = requirementTag(requirement);
          const next: QueueItem = {
            purl: stripPurlVersion(expression.purl),
            via: decision.via === 'optional' ? 'optional' : 'hard',
            by: new Set([candidate]),
            ...(!(range === undefined) && { range }),
            ...(!(tag === undefined) && { tag: true }),
          };
          if (tag !== undefined)
            tagEdges.push({
              requirement,
              base: next.purl,
              ecosystem: ecosystemFromPurl(next.purl),
              tag,
            });
          if (next.via === 'optional')
            optionalEdges.push({
              requirement,
              base: next.purl,
              ecosystem: ecosystemFromPurl(next.purl),
            });
          const key = keyOf(next);
          const already = queued.get(key);
          if (already !== undefined) {
            already.by.add(candidate);
            continue;
          }
          queued.set(key, next);
          queue.push(next);
          warm(next.purl);
        }
      }
      if (admitted === 0 && item.via === 'hard' && candidates.length > 0)
        unresolve(item, {
          purl: item.purl,
          reason: `no candidate${item.range === undefined ? '' : ` satisfying ${item.range}`} can be installed here`,
        });
    }
  }

  // A dist-tag on an alias is the version the registry said it pointed at, for
  // the solve and for every check after it. A tag the registry did not know
  // becomes a requirement nothing satisfies, so a dependent that needs it cannot
  // be selected, and the walk has already said so.
  for (const edge of tagEdges)
    pinTag(edge, resolvedTags.get(`${edge.base}|${edge.tag}`));

  // An optional dependency that was admitted is installed, so the edge to it
  // is a requirement of the solve. One whose every candidate was left out stays
  // optional and the solve ignores it, as npm does.
  for (const edge of optionalEdges) {
    const codec = codecFor(edge.ecosystem);
    const range = nativeRange(edge.requirement);
    const admittedCandidate = packages.some((instance) => {
      if (instance.identity.canonicalPurl !== edge.base) return false;
      if (range === undefined) return true;
      try {
        return codec.satisfies(instance.nativeVersion, range);
      } catch {
        return true;
      }
    });
    if (admittedCandidate) edge.requirement.optional = false;
  }
  for (const { entry, item } of askedFor)
    if (item.by.size > 0) entry.requiredBy = [...item.by].sort();

  return {
    packages,
    roots: input.roots.map((root) => root.purl),
    truncated: [...new Set(truncated)],
    unresolved,
    skippedMarkers,
    skippedPlatform,
    gated,
  };
}

/** No version of any package satisfies this. */
const NO_VERSION = 'vers:npm/>=0.0.0|<0.0.0';

/**
 * Replace the dist-tag an alias named with the version it pointed at, or with a
 * requirement nothing satisfies when the registry had no such tag.
 */
function pinTag(edge: TagEdge, version: string | undefined): void {
  const { expression, nativeSemantics } = edge.requirement;
  if (expression.type !== 'package') return;
  const data =
    nativeSemantics?.data !== null &&
    typeof nativeSemantics?.data === 'object' &&
    !Array.isArray(nativeSemantics.data)
      ? nativeSemantics.data
      : {};
  const { specKind: _tag, ...rest } = data;
  edge.requirement.expression = {
    ...expression,
    vers:
      version === undefined ? NO_VERSION : `vers:${edge.ecosystem}/${version}`,
  };
  edge.requirement.nativeSemantics = {
    version: nativeSemantics?.version ?? 'npm-v1',
    data: {
      ...rest,
      range: version ?? edge.tag,
      ...(!(version === undefined) && { resolvedFromTag: edge.tag }),
    },
  };
}

/** The platform predicate the npm adapter stores in an instance's native data. */
function hostPredicateOf(
  instance: PackageInstance,
): TargetPredicate | undefined {
  // SAFETY: nativeSemantics.data is adapter-written JSON; only the optional
  // `targetPredicate` the npm adapter stores is read.
  const data = instance.nativeSemantics?.data as
    | { targetPredicate?: TargetPredicate }
    | undefined;
  return data?.targetPredicate;
}
