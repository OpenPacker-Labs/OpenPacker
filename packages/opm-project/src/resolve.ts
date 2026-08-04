import { canonicalDigest } from '@openpacker/canonical';
import type { PackageInstance } from '@openpacker/contracts';
import { OpmError } from './types.js';
import { ecosystemFromPurl, stripPurlVersion } from './spec.js';
import { providerFor, type RegistryOptions } from './registry.js';
import { codecFor } from './codecs.js';

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

/** Requirement kinds that belong in an install. */
const INSTALLED_KINDS = new Set(['runtime', 'peer']);

export interface ResolutionBounds {
  /** Newest candidates kept per package. */
  candidatesPerPackage?: number;
  /** Distinct packages the walk may visit. */
  maximumPackages?: number;
}

const DEFAULT_BOUNDS: Required<ResolutionBounds> = {
  candidatesPerPackage: 6,
  maximumPackages: 256,
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
  const [, variable, op, , literal] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];

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

/**
 * Whether a requirement should be followed during the install walk.
 *
 * Hard requirements always are. Optional ones are followed only when they
 * carry an environment marker that evaluates to true for this host — that is
 * how PyPI encodes "required on this platform" without making every marker a
 * hard edge on every host.
 */
export function shouldFollowRequirement(
  requirement: unknown,
  env: HostEnvironment,
): { follow: boolean; skipReason?: string } {
  const kind = (requirement as { kind?: string }).kind ?? 'runtime';
  if (!INSTALLED_KINDS.has(kind))
    return { follow: false, skipReason: `kind ${kind} is not installed` };

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
  options: RegistryOptions,
): Promise<string[]> {
  const provider = await providerFor(ecosystem, options, [
    'prex.registry.enumerate-versions/1',
  ]);
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
 * Walk from the root requirements to every package they need.
 *
 * Breadth-first, so the shallowest constraint on a package is seen first and
 * the bound truncates the deepest candidates rather than the most relevant
 * ones.
 */
export async function resolveGraph(input: {
  roots: readonly { purl: string; range?: string }[];
  bounds?: ResolutionBounds;
  options?: RegistryOptions;
  host?: HostEnvironment;
}): Promise<ResolvedGraph> {
  const bounds = { ...DEFAULT_BOUNDS, ...(input.bounds ?? {}) };
  const options = input.options ?? {};
  const host = input.host ?? defaultHostEnvironment();
  const packages: PackageInstance[] = [];
  const truncated: string[] = [];
  const unresolved: { purl: string; reason: string }[] = [];
  const skippedMarkers: { purl: string; marker: string }[] = [];
  const inspected = new Set<string>();
  const queued = new Set<string>();

  const queue: { purl: string; range?: string }[] = input.roots.map((root) => ({
    purl: stripPurlVersion(root.purl),
    ...(root.range === undefined ? {} : { range: root.range }),
  }));
  for (const item of queue) queued.add(`${item.purl}|${item.range ?? ''}`);

  while (queue.length > 0) {
    if (queued.size > bounds.maximumPackages)
      throw new OpmError(
        'UNRESOLVABLE',
        `Dependency graph exceeded ${bounds.maximumPackages} packages. ` +
          `Raise the bound deliberately rather than resolving an unbounded graph.`,
      );
    const item = queue.shift()!;
    const ecosystem = ecosystemFromPurl(item.purl);

    let candidates: string[];
    try {
      candidates = await candidatesFor(
        ecosystem,
        item.purl,
        item.range,
        options,
      );
    } catch (error) {
      unresolved.push({
        purl: item.purl,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
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
    if (candidates.length > bounds.candidatesPerPackage) {
      truncated.push(item.purl);
      candidates = candidates.slice(0, bounds.candidatesPerPackage);
    }

    const provider = await providerFor(ecosystem, options, [
      'prex.registry.package-metadata/1',
    ]);
    for (const candidate of candidates) {
      if (inspected.has(candidate)) continue;
      inspected.add(candidate);
      let instance: PackageInstance;
      try {
        instance = (await provider.inspect(candidate)).package;
      } catch (error) {
        unresolved.push({
          purl: candidate,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      // Requirements whose markers are true for this host become hard edges
      // for the solver. Adapters leave them `optional: true` so capture does
      // not invent host truth; resolve is the place that decides.
      const rewrittenRequirements = (instance.requirements ?? []).map(
        (requirement) => {
          const decision = shouldFollowRequirement(requirement, host);
          if (
            decision.follow &&
            (requirement as { optional?: boolean }).optional === true
          ) {
            return { ...requirement, optional: false };
          }
          return requirement;
        },
      );
      packages.push({
        ...instance,
        requirements: rewrittenRequirements,
      } as PackageInstance);

      for (const requirement of rewrittenRequirements) {
        const decision = shouldFollowRequirement(requirement, host);
        if (!decision.follow) {
          const marker = requirementMarker(requirement);
          if (
            marker !== undefined &&
            decision.skipReason?.startsWith('marker false')
          ) {
            const expression = (
              requirement as { expression?: { purl?: string } }
            ).expression;
            if (expression?.purl)
              skippedMarkers.push({ purl: expression.purl, marker });
          }
          // Marker unknown: surface so a silent empty graph is not the only
          // signal that something was skipped.
          if (decision.skipReason?.startsWith('marker not evaluable')) {
            const expression = (
              requirement as { expression?: { purl?: string } }
            ).expression;
            if (expression?.purl)
              unresolved.push({
                purl: expression.purl,
                reason: decision.skipReason,
              });
          }
          continue;
        }
        const expression = (requirement as { expression?: { purl?: string } })
          .expression;
        if (!expression?.purl) continue;
        const range = nativeRange(requirement);
        const next = {
          purl: stripPurlVersion(expression.purl),
          ...(range === undefined ? {} : { range }),
        };
        const key = `${next.purl}|${next.range ?? ''}`;
        if (queued.has(key)) continue;
        queued.add(key);
        queue.push(next);
      }
    }
  }

  return {
    packages,
    roots: input.roots.map((root) => root.purl),
    truncated: [...new Set(truncated)],
    unresolved,
    skippedMarkers,
  };
}

/**
 * Load the PREX solver for Node.
 *
 * Through the package's `wasm-node` entry, which wasm-bindgen builds for the
 * nodejs target and which reads the module with `readFileSync`. The generic
 * loader hands wasm-bindgen a relative URL instead and resolves it with
 * `fetch`, and Node's fetch has no `file:` scheme — so that path throws "not
 * implemented" rather than loading anything.
 */
async function loadResolver() {
  const { createEmbeddedResolver } = await import('@openpacker/embedded');
  const specifier = '@openpacker/embedded/wasm-node';
  const bindings = (await import(specifier)) as Record<string, unknown>;
  return createEmbeddedResolver(bindings as never);
}

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
}): Promise<{
  selected: PackageInstance[];
  solutionDigest: string;
  proofValid: boolean;
}> {
  const resolver = await loadResolver();
  const universe = await universeFrom(input.graph);

  const request = {
    environment: { installed: [], locked: [] },
    evaluationTime: input.evaluationTime ?? new Date().toISOString(),
    mode: 'closure',
    objectives: [
      'satisfy-hard-constraints',
      'minimize-package-count',
      'exclude-lifecycle-denied',
      'prefer-stable',
      'prefer-highest-native-version',
      'canonical-lexical-tie-break',
    ],
    policy: {
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
      libc: 'glibc',
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
        ...(root.vers === undefined ? {} : { vers: root.vers }),
      },
      id: `root-${index}`,
      kind: 'runtime',
      optional: false,
      semanticLoss: [],
      source: { type: 'overlay', uri: 'opm://project' },
    })),
  };

  const solved = resolver.solve({
    request: request as never,
    universe: universe as never,
  });
  // The proof is checked rather than trusted: an unchecked proof is only a
  // claim, and invariant 5 makes an invalid one a hard failure.
  const checked = resolver.check(
    { request: request as never, universe: universe as never },
    solved,
  );
  if (!checked.valid)
    throw new OpmError(
      'UNRESOLVABLE',
      `The solver returned a solution its own proof checker rejected: ${checked.diagnostics.join('; ')}`,
    );

  const byNodeId = new Map(
    input.graph.packages.map((instance) => [instance.nodeId, instance]),
  );
  return {
    selected: solved.solution.selectedNodeIds
      .map((nodeId) => byNodeId.get(nodeId))
      .filter(
        (instance): instance is PackageInstance => instance !== undefined,
      ),
    solutionDigest: solved.solution.solutionDigest as unknown as string,
    proofValid: checked.valid,
  };
}

/** A `ResolutionUniverse` over everything the walk found. */
export async function universeFrom(
  graph: ResolvedGraph,
): Promise<Record<string, unknown>> {
  const body = {
    universeVersion: '1',
    packages: graph.packages,
    overlays: [],
    sourceSnapshots: [],
    lifecycleRoot: await canonicalDigest([]),
    targetVocabularyVersion: '1',
  };
  return { ...body, canonicalDigest: await canonicalDigest(body) };
}
