import type { Requirement } from '@openpacker/contracts';
import { codecFor } from './codecs.js';
import { purlPackageName } from './spec.js';

/**
 * What an edge of the closure says, read from the native data the adapter
 * wrote: the range in the ecosystem's own grammar, and the name the dependent
 * finds the package under.
 */

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

/**
 * Whether `version` is inside `range` by the ecosystem's own rules. A range its
 * codec cannot read cannot be checked, which is not the same as being outside.
 */
export function satisfiesNative(
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

/** The adapter's native data on a requirement, as a plain record. */
function nativeData(requirement: Requirement): Record<string, unknown> {
  const data = requirement.nativeSemantics?.data;
  return data !== null && typeof data === 'object' && !Array.isArray(data)
    ? data
    : {};
}

/**
 * The name a dependent finds this requirement's package under: the dependency
 * key of an alias (`string-width-cjs`), else the package's own name.
 */
export function requirementInstallName(requirement: Requirement): string {
  const named = nativeData(requirement).installName;
  if (typeof named === 'string' && named !== '') return named;
  return purlPackageName(
    requirement.expression.type === 'package'
      ? requirement.expression.purl
      : '',
  );
}

/** Whether the requirement is written as an alias of another package. */
export function isAliasRequirement(requirement: Requirement): boolean {
  const named = nativeData(requirement).installName;
  return typeof named === 'string' && named !== '';
}

/** The dist-tag a requirement names instead of a range, if it does. */
export function requirementTag(requirement: Requirement): string | undefined {
  const data = nativeData(requirement);
  return data.specKind === 'tag' && typeof data.range === 'string'
    ? data.range
    : undefined;
}

/** Whether the adapter recorded the dependency as shipped inside the package. */
export function isBundledRequirement(requirement: Requirement): boolean {
  return nativeData(requirement).bundled === true;
}
