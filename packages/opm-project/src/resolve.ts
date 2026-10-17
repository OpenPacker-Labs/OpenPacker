import {
  canonicalDigest,
  canonicalProjectionDigest,
} from '@openpacker/canonical';
import {
  DIGEST_PROJECTIONS,
  type JsonValue,
  type PackageInstance,
  type PolicyInput,
  type Requirement,
  type TargetPredicate,
} from '@openpacker/contracts';
import type { CatalogProvider } from '@openpacker/adapter-core';
import type { EmbeddedResolver } from '@openpacker/embedded';
import { OpmError } from './types.js';
import { ecosystemFromPurl, stripPurlVersion } from './spec.js';
import { ProviderPool, type RegistryOptions } from './registry.js';
import { codecFor } from './codecs.js';
import { isChangedUnderTheResolve } from './registry-changed.js';
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
 * Requirement kinds that belong in an install.
 *
 * `optional` is npm's `optionalDependencies`, which npm installs and tolerates
 * the failure of. Whether one belongs *here* depends on the host, so the walk
 * decides it per dependency (see `shouldFollowRequirement`); the kind is listed
 * so that an optional edge the walk made hard is read as an install edge.
 */
const INSTALLED_KINDS = new Set(['runtime', 'peer', 'optional']);

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
  /** Packages reachable but not resolvable, with the reason. */
  unresolved: { purl: string; reason: string }[];
  /** Marker-gated requirements skipped because the host marker is false. */
  skippedMarkers: { purl: string; marker: string }[];
  /** Optional dependencies left out because this host is not one they run on. */
  skippedPlatform: { purl: string; reason: string }[];
  /** Candidates the caller's gate left out, with its reason. */
  gated: { purl: string; reason: string }[];
}

/**
 * The native range a requirement expresses, in its own ecosystem's syntax.
 *
 * Ecosystems do not agree on the field name. npm stores `range`, PyPI stores
 * `specifier`, and some capture paths leave only the raw string. Reading only
 * `range` made every PyPI edge look unconstrained (or worse, dropped when
 * paired with other bugs), which is why a Python graph looked unresolved.
 */
export function nativeRange(requirement: unknown): string | undefined {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const value = requirement as {
    nativeSemantics?: { data?: Record<string, unknown> };
    raw?: unknown;
    expression?: { vers?: unknown };
  };
  const data = value.nativeSemantics?.data;
  if (data) {
    for (const key of ['range', 'specifier'] as const) {
      const candidate = data[key];
      if (typeof candidate === 'string' && candidate.trim() !== '')
        return candidate.trim();
    }
  }
  if (value.raw && typeof value.raw === 'object' && !Array.isArray(value.raw)) {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const raw = value.raw as { range?: unknown; specifier?: unknown };
    if (typeof raw.range === 'string' && raw.range.trim() !== '')
      return raw.range.trim();
    if (typeof raw.specifier === 'string' && raw.specifier.trim() !== '')
      return raw.specifier.trim();
  }
  if (typeof value.raw === 'string' && value.raw.trim() !== '') {
    // PEP 508: "name[extra]>=1.0; marker" → keep the specifier body.
    const body = value.raw.split(';', 1)[0]!.trim();
    const withoutExtras = body.replace(/\[[^\]]*]/g, '');
    const match = /([<>=!~]=?.+)$/.exec(withoutExtras);
    if (match) return match[1]!.trim();
  }
  return undefined;
}

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
 * range (a git URL, a dist-tag, an alias) is never followed: reading it as the
 * registry's package of that name is how dependency confusion lands.
 */
export function shouldFollowRequirement(
  requirement: Requirement,
  env: HostEnvironment,
): FollowDecision {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const kind = (requirement as { kind?: string }).kind ?? 'runtime';
  if (!INSTALLED_KINDS.has(kind))
    return { follow: false, skipReason: `kind ${kind} is not installed` };

  const specKind = nativeSpecKind(requirement);
  if (specKind !== undefined && specKind !== 'range')
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
  if (range === undefined || range === '' || range === '*')
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
  via: 'hard' | 'optional';
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
  | { candidates: string[]; bounded: boolean; found: CandidateOutcome[] };

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
  const unresolved: { purl: string; reason: string }[] = [];
  const skippedMarkers: { purl: string; marker: string }[] = [];
  const skippedPlatform: { purl: string; reason: string }[] = [];
  const gated: { purl: string; reason: string }[] = [];
  const reported = new Set<string>();
  const expanded = new Set<string>();
  const queued = new Set<string>();
  const discovered = new Set<string>();
  /** Optional edges, made hard afterwards if their target was admitted. */
  const optionalEdges: {
    requirement: Requirement;
    base: string;
    ecosystem: string;
    range?: string;
  }[] = [];

  const keyOf = (item: QueueItem) =>
    `${item.purl}|${item.range ?? ''}|${item.via}`;
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
    ...(!(root.range === undefined) && { range: root.range }),
  }));
  for (const item of queue) {
    queued.add(keyOf(item));
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
        unresolved.push({ purl: item.purl, reason: ready.failure });
        continue;
      }
      const { candidates, found } = ready;
      if (candidates.length === 0) {
        unresolved.push({
          purl: item.purl,
          reason:
            item.range === undefined
              ? 'the registry published no versions'
              : `no published version satisfies ${item.range}`,
        });
        continue;
      }
      if (ready.bounded) truncated.push(item.purl);

      let admitted = 0;
      for (const [index, candidate] of candidates.entries()) {
        const outcome = found[index]!;
        if (outcome.kind !== 'ok') {
          if (!reported.has(candidate)) {
            reported.add(candidate);
            (outcome.kind === 'gated' ? gated : unresolved).push({
              purl: candidate,
              reason: outcome.reason,
            });
          }
          continue;
        }
        const { instance } = outcome;

        if (outcome.host === false) {
          const reason = `does not run on this host (${describeTarget(host.nativeTarget)})`;
          if (item.via === 'optional')
            skippedPlatform.push({ purl: candidate, reason });
          else unresolved.push({ purl: candidate, reason });
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
                });
            }
            continue;
          }
          if (!expression?.purl) continue;
          const range = nativeRange(requirement);
          const next: QueueItem = {
            purl: stripPurlVersion(expression.purl),
            via: decision.via === 'optional' ? 'optional' : 'hard',
            ...(!(range === undefined) && { range }),
          };
          if (next.via === 'optional')
            optionalEdges.push({
              requirement,
              base: next.purl,
              ecosystem: ecosystemFromPurl(next.purl),
              ...(!(range === undefined) && { range }),
            });
          const key = keyOf(next);
          if (queued.has(key)) continue;
          queued.add(key);
          queue.push(next);
          warm(next.purl);
        }
      }
      if (admitted === 0 && item.via === 'hard' && candidates.length > 0)
        unresolved.push({
          purl: item.purl,
          reason: `no candidate${item.range === undefined ? '' : ` satisfying ${item.range}`} can be installed here`,
        });
    }
  }

  // An optional dependency that was admitted is installed, so the edge to it
  // is a requirement of the solve. One whose every candidate was left out stays
  // optional and the solve ignores it, as npm does.
  for (const edge of optionalEdges) {
    const codec = codecFor(edge.ecosystem);
    const admittedCandidate = packages.some((instance) => {
      if (instance.identity.canonicalPurl !== edge.base) return false;
      if (edge.range === undefined) return true;
      try {
        return codec.satisfies(instance.nativeVersion, edge.range);
      } catch {
        return true;
      }
    });
    if (admittedCandidate) edge.requirement.optional = false;
  }

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

/**
 * Load the PREX solver for Node.
 *
 * Through the package's `wasm-node` entry, which wasm-bindgen builds for the
 * nodejs target and which reads the module with `readFileSync`. The generic
 * loader hands wasm-bindgen a relative URL instead and resolves it with
 * `fetch`, and Node's fetch has no `file:` scheme — so that path throws "not
 * implemented" rather than loading anything.
 *
 * A checkout that could not build the wasm target (no `wasm32` toolchain, no
 * `wasm-bindgen`) still builds the Node-API addon from the same crate, so the
 * solver falls back to `@openpacker/embedded/native` rather than returning no
 * closure at all. Both are the same engine; `tests/compat/native-node.test.mjs`
 * holds them to the same answers.
 */
export async function loadResolver(
  importers: {
    wasm?: () => Promise<Record<string, unknown>>;
    native?: () => Promise<EmbeddedResolver>;
  } = {},
): Promise<EmbeddedResolver> {
  const embedded = await import('@openpacker/embedded');
  const wasm =
    importers.wasm ??
    (async () => {
      const specifier = '@openpacker/embedded/wasm-node';
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      return (await import(specifier)) as Record<string, unknown>;
    });
  try {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    return embedded.createEmbeddedResolver((await wasm()) as never);
  } catch (wasmError) {
    if (!isMissingModule(wasmError)) throw wasmError;
    try {
      return await (importers.native ?? loadNativeResolver)();
    } catch (nativeError) {
      if (!isMissingModule(nativeError)) throw nativeError;
      throw new OpmError(
        'UNRESOLVABLE',
        'The PREX solver is not built: neither @openpacker/embedded/wasm-node ' +
          '(npm run build:wasm -w @openpacker/embedded) nor the Node-API addon ' +
          '(npm run build:native -w @openpacker/embedded) is present',
      );
    }
  }
}

async function loadNativeResolver(): Promise<EmbeddedResolver> {
  const specifier = '@openpacker/embedded/native';
  const native = (await import(specifier)) as {
    loadNativeEmbeddedResolver: () => Promise<EmbeddedResolver>;
  };
  return native.loadNativeEmbeddedResolver();
}

/** A module the build never produced, as opposed to one that failed to load. */
function isMissingModule(error: unknown): boolean {
  // SAFETY: only the optional `code` and `message` of a thrown value are read.
  const thrown = error as { code?: unknown; message?: unknown } | null;
  return (
    thrown?.code === 'ERR_MODULE_NOT_FOUND' ||
    thrown?.code === 'MODULE_NOT_FOUND' ||
    // Test runners re-wrap a missing file without keeping Node's code.
    (typeof thrown?.message === 'string' &&
      /Cannot find (?:module|package)|Failed to load url/u.test(thrown.message))
  );
}

/**
 * What a closure solve asks of the engine: satisfy every requirement, and skip
 * what lifecycle policy excludes.
 *
 * Not the optimizing ladder (`minimize-package-count`, `prefer-stable`,
 * `prefer-highest-native-version`, …). The engine can only prove an
 * optimization objective by exhaustive search, so it refuses one past a
 * handful of nodes — "objective optimality cannot be independently proven
 * above 22 nodes", and in practice `RESOURCE_LIMIT` well before that — and a
 * real closure is hundreds of nodes. Asking for optimization there is not a
 * stricter request, it is a refused one, and so nothing could ever have been
 * locked. The same request for every size also means a lock does not change
 * character when one more package pushes the universe over an invisible line.
 *
 * What the lock gets instead is honest about its strength: every hard
 * requirement is satisfied and the checker re-validates exactly that, and the
 * engine makes no claim that the set is the smallest or the newest possible.
 * The choice among candidates is steered by their order, newest first
 * (`sort_candidates` in the Resolvo engine, over the adapter's
 * `versionSortKey`), which is the same greedy rule the native resolvers use.
 */
export const CLOSURE_OBJECTIVES = [
  'satisfy-hard-constraints',
  'exclude-lifecycle-denied',
] as const;

/**
 * Solve the graph with the PREX engine and return the selected instances.
 *
 * This is the solver the repository is built around — CDCL search whose result
 * is checked by an independent proof checker — rather than a greedy
 * newest-satisfying walk. An unsatisfiable graph therefore produces an
 * explanation instead of a silently wrong tree.
 */
export async function solveGraph(input: {
  graph: ResolvedGraph;
  rootRequirements: readonly { purl: string; vers?: string }[];
  evaluationTime?: string;
  policy?: Pick<
    PolicyInput,
    | 'allowYanked'
    | 'allowQuarantined'
    | 'requiredEvidence'
    | 'semanticLossMaximum'
    | 'acceptedOverlayAuthorities'
  >;
}): Promise<{
  selected: PackageInstance[];
  dependencyEdges: { fromNodeId: string; toNodeId: string }[];
  solutionDigest: string;
  proofValid: boolean;
}> {
  const resolver = await loadResolver();

  const request = {
    environment: { installed: [], locked: [] },
    evaluationTime: input.evaluationTime ?? new Date().toISOString(),
    mode: 'closure',
    objectives: [...CLOSURE_OBJECTIVES],
    policy: input.policy ?? {
      acceptedOverlayAuthorities: ['publisher'],
      allowQuarantined: false,
      allowYanked: false,
      requiredEvidence: [],
      semanticLossMaximum: 'warning',
    },
    // `prex-calculus-subset-v1` is the profile whose solutions are formally
    // checkable, which is the point of solving here rather than walking the
    // graph greedily.
    semantics: {
      nativeCompatibility: [
        ...new Set(
          input.graph.packages.map((instance) => instance.identity.purlType),
        ),
      ],
      profile: 'prex-calculus-subset-v1',
    },
    // The host this resolution is for. Reported rather than assumed, so a
    // solution says which machine it is valid on instead of quietly being
    // wrong on another.
    target: {
      abi: {},
      architecture: process.arch === 'x64' ? 'x86_64' : process.arch,
      capabilities: [],
      // What this host reports, and nothing on a host that has no libc to
      // report, instead of a "glibc" that was true only on glibc linux.
      ...(!(defaultHostEnvironment().nativeTarget.libc === undefined) && {
        libc: defaultHostEnvironment().nativeTarget.libc,
      }),
      os: process.platform === 'win32' ? 'windows' : process.platform,
      runtimes: {
        node: process.versions.node.split('.')[0]!,
        python: defaultHostEnvironment().pythonVersion.split('.')[0]!,
      },
      variables: {},
    },
    requirements: input.rootRequirements.map((root, index) => ({
      authority: 'native',
      expression: {
        purl: stripPurlVersion(root.purl),
        type: 'package',
        ...(!(root.vers === undefined) && { vers: root.vers }),
      },
      id: `root-${index}`,
      kind: 'runtime',
      optional: false,
      semanticLoss: [],
      source: { type: 'overlay', uri: 'opm://project' },
    })),
  };

  // The lock holds one version of a package. The engine does not insist on
  // that (a package may legitimately coexist in PREX), so a requirement that
  // takes the newest of its own range and another that takes the newest of
  // another can leave two. When a single candidate would satisfy every selected
  // requirement on the package, the others are withdrawn and the solve is run
  // again; when none would, the closure needs what the lock cannot hold.
  let packages = input.graph.packages;
  let solved: ReturnType<typeof resolver.solve>;
  let selected: PackageInstance[];
  let selectedByPurl: Map<string, PackageInstance>;
  for (let round = 0; ; round += 1) {
    const universe = await universeFrom({ ...input.graph, packages });
    solved = resolver.solve({
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      request: request as never,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      universe: universe as never,
    });
    // The proof is checked rather than trusted: an unchecked proof is only a
    // claim, and invariant 5 makes an invalid one a hard failure.
    const checked = resolver.check(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      { request: request as never, universe: universe as never },
      solved,
    );
    if (!checked.valid)
      throw new OpmError(
        'UNRESOLVABLE',
        `The solver returned a solution its own proof checker rejected: ${checked.diagnostics.join('; ')}`,
      );

    const byNodeId = new Map(
      packages.map((instance) => [instance.nodeId, instance]),
    );
    selected = solved.solution.selectedNodeIds
      .map((nodeId) => byNodeId.get(nodeId))
      .filter(
        (instance): instance is PackageInstance => instance !== undefined,
      );
    const duplicated = new Map<string, PackageInstance[]>();
    selectedByPurl = new Map<string, PackageInstance>();
    for (const instance of selected) {
      const exact = instance.identity.exactPurl;
      if (exact === undefined)
        throw new OpmError(
          'UNRESOLVABLE',
          'Selected package lacks an exact PURL',
        );
      const base = stripPurlVersion(exact);
      const seen = selectedByPurl.get(base);
      if (seen !== undefined)
        duplicated.set(base, [...(duplicated.get(base) ?? [seen]), instance]);
      else selectedByPurl.set(base, instance);
    }
    if (duplicated.size === 0) break;
    if (round >= MAXIMUM_UNIFICATION_ROUNDS)
      throw new OpmError(
        'UNRESOLVABLE',
        `The closure still holds several versions of ${[...duplicated.keys()].join(', ')} after ${MAXIMUM_UNIFICATION_ROUNDS} attempts to unify them`,
      );
    packages = unify({
      packages,
      selected,
      duplicated,
      rootRequirements: input.rootRequirements,
      resolver,
    });
  }
  const dependencyEdges: { fromNodeId: string; toNodeId: string }[] = [];
  for (const instance of selected)
    for (const requirement of instance.requirements ?? []) {
      if (
        requirement.optional ||
        !INSTALLED_KINDS.has(requirement.kind) ||
        requirement.expression.type !== 'package'
      )
        continue;
      const dependency = selectedByPurl.get(
        stripPurlVersion(requirement.expression.purl),
      );
      if (dependency === undefined)
        throw new OpmError(
          'UNRESOLVABLE',
          `Selected closure omits required package ${requirement.expression.purl}`,
        );
      // The solver enforced a comparison form of the range; the ecosystem's own
      // reading of it has the last word, so a lock never pairs a package with a
      // version it does not accept.
      const range = nativeRange(requirement);
      if (
        range !== undefined &&
        !satisfiesNative(
          dependency.identity.purlType,
          dependency.nativeVersion,
          range,
        )
      )
        throw new OpmError(
          'UNRESOLVABLE',
          `${instance.identity.exactPurl} requires ${requirement.expression.purl} ${range}, ` +
            `but the closure selected ${dependency.identity.exactPurl}`,
        );
      dependencyEdges.push({
        fromNodeId: instance.nodeId,
        toNodeId: dependency.nodeId,
      });
    }
  return {
    selected,
    dependencyEdges,
    solutionDigest: solved.solution.solutionDigest.value,
    // An invalid proof never gets this far: the loop above throws on it.
    proofValid: true,
  };
}

/** Enough for a closure of ordinary shape; a loop here is a bug, not a graph. */
const MAXIMUM_UNIFICATION_ROUNDS = 32;

/**
 * Withdraw every candidate of a duplicated package but one that all of its
 * selected dependents accept, or say who cannot agree.
 *
 * The candidate is the newest one that satisfies, by the ecosystem's own reading
 * of each range, every selected requirement on the package, and the root
 * requirement on it if there is one. Nothing else about the universe changes, so
 * the next solve may still move any other package.
 */
function unify(input: {
  packages: PackageInstance[];
  selected: readonly PackageInstance[];
  duplicated: ReadonlyMap<string, PackageInstance[]>;
  rootRequirements: readonly { purl: string; vers?: string }[];
  resolver: Pick<EmbeddedResolver, 'versionSatisfies'>;
}): PackageInstance[] {
  const withdrawn = new Set<string>();
  for (const [base, chosen] of input.duplicated) {
    const ecosystem = chosen[0]!.identity.purlType;
    const needs: {
      by: string;
      range: string;
      accepts: (v: string) => boolean;
    }[] = [];
    for (const root of input.rootRequirements)
      if (stripPurlVersion(root.purl) === base && root.vers !== undefined) {
        const vers = root.vers;
        needs.push({
          by: 'the direct requirement',
          range: vers.replace(/^vers:[^/]+\//u, ''),
          accepts: (version) => input.resolver.versionSatisfies(version, vers),
        });
      }
    for (const instance of input.selected)
      for (const requirement of instance.requirements ?? []) {
        if (
          requirement.optional ||
          !INSTALLED_KINDS.has(requirement.kind) ||
          requirement.expression.type !== 'package' ||
          stripPurlVersion(requirement.expression.purl) !== base
        )
          continue;
        const range = nativeRange(requirement);
        if (range !== undefined)
          needs.push({
            by: instance.identity.exactPurl ?? instance.nodeId,
            range,
            accepts: (version) => satisfiesNative(ecosystem, version, range),
          });
      }
    const codec = codecFor(ecosystem);
    const candidates = input.packages
      .filter((item) => item.identity.canonicalPurl === base)
      .sort((left, right) =>
        codec.compareNativeVersions(right.nativeVersion, left.nativeVersion),
      );
    const agreed = candidates.find((candidate) =>
      needs.every((need) => need.accepts(candidate.nativeVersion)),
    );
    if (agreed === undefined)
      throw new OpmError(
        'UNRESOLVABLE',
        `${base} is needed at versions no single release satisfies, and a lock holds one version of a package: ` +
          needs.map((need) => `${need.by} requires ${need.range}`).join('; ') +
          `. The closure would need ${chosen
            .map((item) => item.identity.exactPurl)
            .join(' and ')}`,
      );
    for (const candidate of candidates)
      if (candidate !== agreed) withdrawn.add(candidate.nodeId);
  }
  return input.packages.filter((item) => !withdrawn.has(item.nodeId));
}

/**
 * Whether `version` is inside `range` by the ecosystem's own rules. A range its
 * codec cannot read cannot be checked, which is not the same as being outside.
 */
function satisfiesNative(
  ecosystem: string,
  version: string,
  range: string,
): boolean {
  try {
    return codecFor(ecosystem).satisfies(version, range);
  } catch {
    return true;
  }
}

/** A `ResolutionUniverse` over everything the walk found. */
export async function universeFrom(
  graph: ResolvedGraph,
): Promise<Record<string, unknown>> {
  const packages = graph.packages.map((instance) => ({
    ...instance,
    requirements: instance.requirements.map((requirement) => ({
      ...requirement,
      expression: completeExpression(requirement.expression),
    })),
    capabilities: instance.capabilities.map((capability) => ({
      attributes: {},
      ...capability,
    })),
    conflicts: instance.conflicts.map((conflict) => ({
      ...conflict,
      expression: completeExpression(conflict.expression),
    })),
    cardinalityConstraints: instance.cardinalityConstraints.map(
      (constraint) => ({
        ...constraint,
        selector: completeExpression(constraint.selector),
      }),
    ),
  }));
  const body = {
    universeVersion: '1',
    packages,
    overlays: [],
    sourceSnapshots: [],
    lifecycleRoot: await canonicalDigest([]),
    targetVocabularyVersion: '1',
  };
  const projection = DIGEST_PROJECTIONS.projections.find(
    ({ id }) => id === 'universe-v1',
  );
  if (!projection)
    throw new OpmError('INTERNAL_ERROR', 'Missing universe-v1 projection');
  const universeDigest = await canonicalProjectionDigest(
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    JSON.parse(JSON.stringify(body)) as JsonValue,
    projection,
  );
  return {
    ...body,
    canonicalDigest: universeDigest,
  };
}

function completeExpression(input: JsonValue): JsonValue {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return input;
  if (input.type === 'package') return { qualifiers: {}, ...input };
  if (input.type === 'capability') return { attributes: {}, ...input };
  if (input.type === 'allOf' || input.type === 'anyOf')
    return {
      ...input,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      expressions: (input.expressions as JsonValue[]).map(completeExpression),
    };
  if (input.type === 'not')
    return {
      ...input,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      expression: completeExpression(input.expression as JsonValue),
    };
  if (input.type === 'conditional')
    return {
      ...input,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      // oxlint-disable-next-line unicorn/no-thenable -- PREX conditional AST field.
      then: completeExpression(input.then as JsonValue),
      ...(!(input.else === undefined) && {
        else: completeExpression(input.else),
      }),
    };
  return input;
}
