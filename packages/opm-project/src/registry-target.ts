import type { PolicyDocument } from '@openpacker/policy';
import type { CatalogProvider } from '@openpacker/adapter-core';
import { codecFor, hasCodec } from './codecs.js';
import { listRegistryVersions, type RegistryOptions } from './registry.js';
import { stripPurlVersion } from './spec.js';
import { insideReleaseAge } from './supply-chain.js';
import { OpmError } from './types.js';

/**
 * Which release of a package a direct requirement means, when the manifest
 * names a range or a dist-tag instead of a version.
 *
 * A version the ecosystem reads as a version is that version. Otherwise the
 * hint is a range, and the newest release inside it that the policy's minimum
 * release age allows is the one; and if the ecosystem cannot read it as a range
 * either, it is a dist-tag, which the registry resolves. Before this a range was
 * not read at all and the newest release of the package was taken, so
 * `string-width-cjs@npm:string-width@^4` could have locked 7.x.
 */

/** Whether `hint` is one release, in the ecosystem's own grammar. */
export function isExactVersion(ecosystem: string, hint: string): boolean {
  // With no codec nothing can tell a range or a tag from a version, so what the
  // manifest wrote is a version, as it was before ranges were read, and the
  // registry the adapter names accepts or refuses it.
  if (!hasCodec(ecosystem)) return true;
  try {
    codecFor(ecosystem).parseNativeVersion(hint);
    return true;
  } catch {
    return false;
  }
}

/**
 * The range or dist-tag in opm.toml's `version` that the registry has to
 * resolve, or undefined when it is a version. An ecosystem whose adapter has no
 * codec cannot tell the two apart, so what was written goes to the adapter as
 * it is, as the exact version asked for; only a codec reads a range or a tag
 * (npm's resolves `latest` through the registry's dist-tags).
 */
export function registryHintFor(
  ecosystem: string,
  version: string | undefined,
): string | undefined {
  if (version === undefined || version === '' || !hasCodec(ecosystem))
    return undefined;
  return isExactVersion(ecosystem, version) ? undefined : version;
}

/** What a version (not a range) may be spelled with, in any ecosystem. */
const VERSION_SPELLING = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;

/**
 * Whether opm.toml's `version` pins one release. `latest` and `1.2.x` are
 * spelled like a version, but npm's codec reads neither as one: the first is a
 * dist-tag and the second a range, so neither is held to the lock's version
 * as a pin is. An ecosystem whose adapter has no codec is judged by the
 * spelling alone, as before.
 */
export function isPinnedVersion(ecosystem: string, version: string): boolean {
  if (!VERSION_SPELLING.test(version)) return false;
  return !hasCodec(ecosystem) || isExactVersion(ecosystem, version);
}

interface TagSource {
  resolveTag(basePurl: string, tag: string): Promise<string | undefined>;
}

/** Whether the provider can say which version a dist-tag points at. */
export function canResolveTags(
  provider: CatalogProvider,
): provider is CatalogProvider & TagSource {
  return (
    'resolveTag' in provider &&
    typeof (provider as { resolveTag?: unknown }).resolveTag === 'function'
  );
}

export async function registryTargetFor(input: {
  ecosystem: string;
  /** The package, with or without a version. */
  purl: string;
  /** A range or a dist-tag the manifest wrote. */
  hint: string;
  options: RegistryOptions;
  provider: CatalogProvider;
  policy: PolicyDocument;
  evaluationTime: string;
}): Promise<string> {
  const base = stripPurlVersion(input.purl);
  const codec = codecFor(input.ecosystem);
  let isRange = true;
  try {
    codec.parseNativeRange(input.hint);
  } catch {
    isRange = false;
  }
  if (!isRange) {
    if (!canResolveTags(input.provider))
      throw new OpmError(
        'UNRESOLVABLE',
        `"${input.hint}" is not a version or a range, and this ${input.ecosystem} registry cannot resolve it as a dist-tag`,
      );
    const tagged = await input.provider.resolveTag(base, input.hint);
    if (tagged === undefined)
      throw new OpmError(
        'UNRESOLVABLE',
        `${base} has no version or dist-tag "${input.hint}"`,
      );
    return tagged;
  }
  const versions = await listRegistryVersions(
    input.ecosystem,
    base,
    input.options,
  );
  const inRange = versions.filter((exact) => {
    const version = exact.slice(exact.lastIndexOf('@') + 1);
    try {
      return codec.satisfies(decodeURIComponent(version), input.hint);
    } catch {
      return false;
    }
  });
  for (let index = inRange.length - 1; index >= 0; index -= 1)
    if (
      !(await insideReleaseAge(
        input.policy,
        input.provider,
        inRange[index]!,
        input.evaluationTime,
      ))
    )
      return inRange[index]!;
  const newest = inRange.at(-1);
  if (newest !== undefined) return newest;
  throw new OpmError(
    'UNRESOLVABLE',
    `No published version of ${base} satisfies ${input.hint}` +
      (versions.length === 0
        ? ' (the registry published none)'
        : ` (newest is ${versions.at(-1)!.slice(versions.at(-1)!.lastIndexOf('@') + 1)})`),
  );
}
