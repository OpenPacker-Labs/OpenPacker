import { describe, expect, it } from 'vitest';
import type { NativeLockEntry } from '@openpacker/adapter-core';
import { planLayout, toLayoutEntries, type LayoutPlan } from './layout-plan.js';

/**
 * Names that differ only by case. An alias is chosen by whoever published the
 * package that has it, and a directory called `React` beside one called `react`
 * is one directory on a case-insensitive filesystem (macOS and Windows by
 * default), where the second write would silently replace the first.
 */

interface Spec {
  direct?: boolean;
  requires?: string[];
  aliases?: Record<string, string>;
  installName?: string;
}

function entry(id: string, spec: Spec = {}): NativeLockEntry {
  const at = id.lastIndexOf('@');
  const name = id.slice(0, at);
  const version = id.slice(at + 1);
  return {
    purl: `pkg:npm/${name}`,
    exactPurl: `pkg:npm/${name}@${version}`,
    name,
    version,
    scope: 'runtime',
    source: `https://registry.example/${name}-${version}.tgz`,
    digest: `sha256:${id.replace(/\W/gu, '').padEnd(64, '0')}`,
    size: 1,
    transitive: spec.direct !== true,
    alias: id,
    ...(spec.requires !== undefined && { dependencies: spec.requires }),
    ...(spec.aliases !== undefined && { aliases: spec.aliases }),
    ...(spec.installName !== undefined && { installName: spec.installName }),
  };
}

const where = (plan: LayoutPlan): string[] =>
  plan.placements
    .map((place) => `${place.chain.join('>')}=${place.entry.id}`)
    .sort();

/** Directories that a case-insensitive filesystem would make one. */
const collisions = (plan: LayoutPlan): string[] => {
  const seen = new Map<string, string>();
  const out: string[] = [];
  for (const place of plan.placements) {
    const folded = place.chain.join('>').toLowerCase();
    const first = seen.get(folded);
    if (first !== undefined) out.push(`${first} and ${place.chain.join('>')}`);
    else seen.set(folded, place.chain.join('>'));
  }
  return out;
};

describe('install names that differ only by case', () => {
  it('nests the second beside its dependent, so no two directories fold into one', () => {
    // app needs react, and also an unrelated package under the alias React.
    const plan = planLayout(
      toLayoutEntries([
        entry('app@1.0.0', {
          direct: true,
          requires: ['react@18.2.0'],
          aliases: { React: 'evil@1.0.0' },
        }),
        entry('react@18.2.0'),
        entry('evil@1.0.0'),
      ]),
    );
    expect(plan.skipped).toEqual([]);
    expect(collisions(plan)).toEqual([]);
    expect(where(plan)).toHaveLength(3);
    // Both are installed, one at the root and the other inside app.
    expect(
      where(plan).filter((place) => /^(app>)?(react|React)=/u.test(place)),
    ).toHaveLength(2);
  });

  it('says so, and installs neither twice, when the dependent has a variant of its own too', () => {
    // The root holds react@1 (direct). d needs react@2, which nests in d, and
    // an unrelated package as React: it fits neither at the root nor in d.
    const plan = planLayout(
      toLayoutEntries([
        entry('react@1.0.0', { direct: true }),
        entry('d@1.0.0', {
          direct: true,
          requires: ['react@2.0.0'],
          aliases: { React: 'evil@1.0.0' },
        }),
        entry('react@2.0.0'),
        entry('evil@1.0.0'),
      ]),
    );
    expect(collisions(plan)).toEqual([]);
    expect(plan.skipped.map((skip) => skip.entry.id)).toEqual(['evil@1.0.0']);
    expect(plan.skipped[0]!.reason).toMatch(
      /React.*differs only by case from react/u,
    );
  });

  it('refuses a second direct requirement whose directory differs only by case', () => {
    const plan = planLayout(
      toLayoutEntries([
        entry('react@18.2.0', { direct: true }),
        entry('evil@1.0.0', { direct: true, installName: 'React' }),
      ]),
    );
    expect(collisions(plan)).toEqual([]);
    expect(plan.placements).toHaveLength(1);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]!.reason).toMatch(/differs only by case/u);
  });

  it('does not touch names that differ in more than case, or the same name twice', () => {
    const plan = planLayout(
      toLayoutEntries([
        entry('app@1.0.0', {
          direct: true,
          requires: ['react@18.2.0'],
          aliases: { 'react-cjs': 'react@18.2.0' },
        }),
        entry('react@18.2.0'),
      ]),
    );
    expect(plan.skipped).toEqual([]);
    expect(where(plan)).toEqual([
      'app=app@1.0.0',
      'react-cjs=react@18.2.0',
      'react=react@18.2.0',
    ]);
  });
});
