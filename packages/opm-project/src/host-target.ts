import type { TargetPredicate } from '@openpacker/contracts';

/**
 * The machine a resolve is for, in the vocabulary npm writes `os`, `cpu` and
 * `libc` in (Node's `process.platform` and `process.arch`, and `glibc` or
 * `musl`). An npm package's target predicate is stored in that vocabulary
 * verbatim, so it is matched against this and not against the PREX target the
 * solver is given.
 */
export interface NativeTarget {
  os: string;
  architecture: string;
  /** Only meaningful on linux; npm itself ignores `libc` elsewhere. */
  libc?: string;
}

/** Whether the running Node was linked against glibc, by what Node itself reports. */
export function detectLibc(): 'glibc' | 'musl' | undefined {
  if (process.platform !== 'linux') return undefined;
  // SAFETY: `excludeNetwork` is a documented writable property of
  // process.report that @types/node does not declare.
  const report = process.report as
    | (typeof process.report & { excludeNetwork?: boolean })
    | undefined;
  if (report === undefined) return undefined;
  // The report enumerates network interfaces, which is slow and irrelevant.
  const previous = report.excludeNetwork;
  report.excludeNetwork = true;
  try {
    // SAFETY: Node documents `header.glibcVersionRuntime` on linux; only that
    // optional field is read.
    const header = (
      report.getReport() as { header?: { glibcVersionRuntime?: unknown } }
    ).header;
    return typeof header?.glibcVersionRuntime === 'string' ? 'glibc' : 'musl';
  } catch {
    return undefined;
  } finally {
    report.excludeNetwork = previous === true;
  }
}

export function detectNativeTarget(
  overrides: Partial<NativeTarget> = {},
): NativeTarget {
  const libc = overrides.libc ?? detectLibc();
  return {
    os: overrides.os ?? process.platform,
    architecture: overrides.architecture ?? process.arch,
    ...(!(libc === undefined) && { libc }),
  };
}

/**
 * Evaluate a target predicate over a native target.
 *
 * `'unknown'` is returned for a predicate this does not understand, so the
 * caller decides what unknown means for it instead of this inventing a yes. A
 * `libc` clause on a host that has no libc to report is satisfied, as it is for
 * npm.
 */
export function evaluateTargetPredicate(
  predicate: TargetPredicate,
  target: NativeTarget,
): boolean | 'unknown' {
  switch (predicate.type) {
    case 'true':
      return true;
    case 'false':
      return false;
    case 'in':
    case 'notIn': {
      const value = scalar(predicate.path, target);
      if (value === undefined)
        return predicate.path === 'libc' ? true : 'unknown';
      const present = predicate.values.includes(value);
      return predicate.type === 'in' ? present : !present;
    }
    case 'equals':
    case 'notEquals': {
      const value = scalar(predicate.path, target);
      if (value === undefined)
        return predicate.path === 'libc' ? true : 'unknown';
      const same = predicate.value === value;
      return predicate.type === 'equals' ? same : !same;
    }
    case 'allOf':
    case 'anyOf': {
      const results = predicate.predicates.map((item) =>
        evaluateTargetPredicate(item, target),
      );
      if (predicate.type === 'allOf') {
        if (results.includes(false)) return false;
        return results.includes('unknown') ? 'unknown' : true;
      }
      if (results.includes(true)) return true;
      return results.includes('unknown') ? 'unknown' : false;
    }
    case 'not': {
      const result = evaluateTargetPredicate(predicate.predicate, target);
      return result === 'unknown' ? 'unknown' : !result;
    }
    default:
      return 'unknown';
  }
}

function scalar(path: string, target: NativeTarget): string | undefined {
  switch (path) {
    case 'os':
      return target.os;
    case 'architecture':
      return target.architecture;
    case 'libc':
      return target.libc;
    default:
      return undefined;
  }
}
