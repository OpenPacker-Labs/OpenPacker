/**
 * What a frozen install of a pnpm lock cannot honour, by name (ADR 0055 §20).
 *
 * Three kinds, asked in this order: what the lock as a whole says (links left
 * out of it; its patches are `patches.ts`'s), what an importer being installed says (a link to
 * something that is not a member), and what an instance being installed is (a
 * source this install does not fetch, a digest that does not pin its bytes).
 * Every refusal is collected, not thrown, so one run names everything.
 */

import type {
  FrozenLockRefusal,
  FrozenSourceKind,
} from '@openpacker/adapter-core';
import { classifyResolved } from '../frozen-select.js';
import type { PnpmInstance, PnpmModel } from './model.js';
import { quote } from './quote.js';

/** Refusals about the lock as a whole, whatever is installed. */
export function lockRefusals(model: PnpmModel): FrozenLockRefusal[] {
  const { lock } = model;
  const out: FrozenLockRefusal[] = [];
  if (lock.ignoredOptionalDependencies.length > 0)
    out.push({
      path: 'ignoredOptionalDependencies',
      reason: `is ${lock.ignoredOptionalDependencies.map(quote).join(', ')}: the lock was resolved without those optional dependencies, and opm ci does not install such a lock (it does not take them out of the importers' package.json as pnpm does)`,
    });
  if (lock.settings.excludeLinksFromLockfile === true)
    out.push({
      path: 'settings.excludeLinksFromLockfile',
      reason:
        'is true, so the links between workspace members are not in the lock and it cannot say what the importers link',
    });
  for (const importer of lock.importers) {
    if (importer.dependenciesMeta.size > 0)
      out.push({
        path: `importers[${quote(importer.id)}].dependenciesMeta`,
        reason: `sets ${[...importer.dependenciesMeta.keys()].map(quote).join(', ')} (injected, patched or a runtime for a dependency), which opm does not install`,
      });
    if (importer.publishDirectory !== undefined)
      out.push({
        path: `importers[${quote(importer.id)}].publishDirectory`,
        reason:
          'is set, so pnpm links this member from its publish directory, which opm does not',
      });
  }
  return out;
}

/**
 * Refusals about the importers being installed: a link must land on a member
 * the project has. `present` is the importers the project still has.
 */
export function importerRefusals(
  model: PnpmModel,
  tops: ReadonlySet<string>,
  present: ReadonlySet<string> = new Set(model.tops.keys()),
): FrozenLockRefusal[] {
  const out: FrozenLockRefusal[] = [];
  for (const id of tops)
    for (const edge of model.tops.get(id)?.edges ?? []) {
      if (edge.kind !== 'link') continue;
      const path = `importers[${quote(id)}][${quote(edge.as)}]`;
      if (edge.memberId === undefined)
        out.push({
          path,
          reason: `links ${quote(edge.target)}, which is not a workspace member (an importer of this lock); opm links members only`,
        });
      else if (!present.has(edge.memberId))
        out.push({
          path,
          reason: `links ${quote(edge.target)}, an importer of the lock that the project no longer has; opm links members it has only`,
        });
    }
  return out;
}

/** Where an instance's bytes are and what pins them. */
export interface InstanceSource {
  readonly url: string;
  readonly kind: FrozenSourceKind;
  readonly integrity: string;
}

/** The algorithms an integrity may be made with; a sha1 alone does not pin bytes. */
const STRONG = /^sha(?:256|384|512)-/u;

/**
 * Where an instance is fetched from, or why it cannot be. A registry package
 * has no URL in the lock, so it is the registry's standard path for its name
 * and version (less any `+build` metadata, as pnpm builds it); any other is its
 * `resolution` as written. Nothing here fetches.
 */
export function sourceOfInstance(
  instance: PnpmInstance,
  registry: string,
): InstanceSource | { readonly problem: string } {
  const label = quote(`${instance.name}@${instance.version}`);
  const { resolution } = instance.pkg;
  if (instance.links.length > 0)
    return {
      problem: `${label} depends on ${instance.links.map((link) => `${quote(link.as)} as ${quote(`link:${link.target}`)}`).join(', ')}, a directory this install does not place`,
    };
  if (resolution.kind === 'git')
    return {
      problem: `${label} comes from a git repository, which opm ci does not fetch`,
    };
  if (resolution.kind === 'directory')
    return {
      problem: `${label} comes from the directory ${quote(resolution.directory)}, which opm ci does not install`,
    };
  if (resolution.kind === 'variations')
    return {
      problem: `${label} is a runtime with an archive per platform, which opm ci does not install`,
    };
  if (instance.pkg.source === 'file')
    return {
      problem: `${label} is a file: archive, which opm ci does not install`,
    };
  const integrity = resolution.integrity;
  if (integrity === undefined)
    return {
      problem: `${label} has no integrity, so the lock does not pin its bytes`,
    };
  if (!STRONG.test(integrity))
    return {
      problem: `${label} has only a sha1 integrity, which does not pin its bytes`,
    };
  // pnpm's own address (`@pnpm/tarball-url`): the version without its build
  // metadata, which the registry's file name does not carry; it is classified
  // by that version too, or the registry's own path reads as a tarball's.
  // pnpm writes `tarball:` when the registry's file name differs from that,
  // as one that keeps the metadata does: such a path is the registry's too.
  const version = instance.version.split('+', 1)[0]!;
  const url =
    resolution.kind === 'tarball'
      ? resolution.tarball
      : `${registry.replace(/\/+$/u, '')}/${instance.name}/-/${instance.name.split('/').at(-1)}-${version}.tgz`;
  const spellings = [
    version,
    instance.version,
    instance.version.replace('+', '%2B'),
  ];
  const sources = spellings.map((spelling) =>
    classifyResolved({
      packageName: instance.name,
      version: spelling,
      resolved: url,
    }),
  );
  const source =
    sources.find((each) => 'kind' in each && each.kind === 'registry') ??
    sources[0]!;
  if ('problem' in source) return { problem: `${label} ${source.problem}` };
  return { url, kind: source.kind, integrity };
}
