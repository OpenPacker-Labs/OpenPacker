import { describe, expect, it } from 'vitest';
import type { NativeLockEntry } from '@openpacker/adapter-core';
import {
  LayoutLinksError,
  checkLayoutLinks,
  chainOfPlace,
  linkTargetBetween,
  placePath,
} from './layout-links.js';
import {
  planLayout,
  planLayoutFromPaths,
  type LayoutEntry,
} from './layout-plan.js';

function layoutEntry(name: string, version = '1.0.0'): LayoutEntry {
  const source = {
    purl: `pkg:npm/${name}`,
    exactPurl: `pkg:npm/${name}@${version}`,
    name,
    version,
    scope: 'runtime',
    source: 'x',
    digest: `sha256:${name}${version}`,
    size: 1,
    transitive: false,
  } satisfies NativeLockEntry;
  return {
    id: `${name}@${version}`,
    name,
    version,
    digest: source.digest,
    direct: true,
    dependencies: [],
    source,
  };
}

const place = (name: string, ...chain: string[]) => ({
  entry: layoutEntry(name),
  chain: chain.length > 0 ? chain : [name],
});

/** The problems of a rejected set of links, or an empty list when it was accepted. */
function problemsOf(
  links: Parameters<typeof checkLayoutLinks>[0],
  placements: Parameters<typeof checkLayoutLinks>[1] = [],
): readonly string[] {
  try {
    checkLayoutLinks(links, placements);
    return [];
  } catch (error) {
    if (error instanceof LayoutLinksError) return error.problems;
    throw error;
  }
}

const member = {
  path: 'node_modules/@scope/member',
  target: '../../packages/member',
};

describe('checkLayoutLinks', () => {
  it('accepts no links, and returns them in path order', () => {
    expect(checkLayoutLinks([], [])).toEqual([]);
    const links = [
      { path: 'node_modules/zed', target: '../packages/zed' },
      member,
      { path: 'node_modules/alpha', target: '../packages/alpha' },
    ];

    expect(checkLayoutLinks(links, []).map((link) => link.path)).toEqual([
      'node_modules/@scope/member',
      'node_modules/alpha',
      'node_modules/zed',
    ]);
  });

  it('accepts a link inside the node_modules of a package the plan installs', () => {
    expect(
      problemsOf(
        [
          {
            path: 'node_modules/host/node_modules/member',
            target: '../../../packages/member',
          },
        ],
        [{ chain: ['host'] }],
      ),
    ).toEqual([]);
  });

  it.each([
    ['a name that starts with a dot', 'node_modules/.bin', '../x'],
    [
      'a place that is not a node_modules directory',
      'node_modules/a/lib/x',
      '../../../x',
    ],
    ['a scope as the name', 'node_modules/@scope', '../x'],
    ['no node_modules at all', 'packages/member', '../x'],
    ['a path outside the project', '../node_modules/member', '../x'],
    ['an absolute target', 'node_modules/member', '/etc/passwd'],
    ['a target that leaves the project', 'node_modules/member', '../../x'],
    ['an empty target', 'node_modules/member', ''],
    [
      'a target into node_modules',
      'node_modules/member',
      '../node_modules/other',
    ],
    ['a target into opm state', 'node_modules/member', '../.opm/store/x'],
    ['a target with a NUL', 'node_modules/member', '../x\0'],
    ['a target that is the root', 'node_modules/member', '..'],
  ])('refuses %s', (_label, path, target) => {
    const problems = problemsOf([{ path, target }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.startsWith(`${path}: `)).toBe(true);
  });

  it('refuses two links at one place, naming it', () => {
    expect(
      problemsOf([
        { path: 'node_modules/member', target: '../packages/member' },
        { path: 'node_modules/member', target: '../packages/other' },
      ]),
    ).toEqual(['node_modules/member is linked twice']);
  });

  it('refuses a link inside another link', () => {
    expect(
      problemsOf([
        { path: 'node_modules/outer', target: '../packages/outer' },
        {
          path: 'node_modules/outer/node_modules/inner',
          target: '../../../packages/inner',
        },
      ]),
    ).toEqual([
      'node_modules/outer/node_modules/inner sits in the node_modules of outer, which the plan does not install',
      'node_modules/outer/node_modules/inner is inside the link node_modules/outer',
    ]);
  });

  it('refuses a link in the node_modules of a package the plan does not install', () => {
    expect(
      problemsOf([
        {
          path: 'node_modules/ghost/node_modules/member',
          target: '../../../packages/member',
        },
      ]),
    ).toEqual([
      'node_modules/ghost/node_modules/member sits in the node_modules of ghost, which the plan does not install',
    ]);
  });

  it('refuses a link that would take the place of an installed package', () => {
    expect(
      problemsOf(
        [{ path: 'node_modules/a', target: '../packages/a' }],
        [{ chain: ['a'] }],
      ),
    ).toEqual([
      'node_modules/a would replace the package the plan installs there',
    ]);
    expect(
      problemsOf(
        [{ path: 'node_modules/@s/a', target: '../../packages/a' }],
        [{ chain: ['@s/a'] }],
      ),
    ).toEqual([
      'node_modules/@s/a would replace the package the plan installs there',
    ]);
  });

  it('refuses a package that would be written through a link', () => {
    expect(
      problemsOf(
        [{ path: 'node_modules/a', target: '../packages/a' }],
        [{ chain: ['a', 'dep'] }],
      ),
    ).toEqual([
      'the package at node_modules/a/node_modules/dep would be written through the link node_modules/a',
    ]);
  });

  it('reports every problem at once', () => {
    const problems = problemsOf([
      { path: 'node_modules/.bin', target: '../x' },
      { path: 'node_modules/ok', target: '/abs' },
    ]);
    expect(problems).toHaveLength(2);
  });

  it('throws an error with a stable code', () => {
    expect(() =>
      checkLayoutLinks([{ path: 'node_modules/.bin', target: '../x' }], []),
    ).toThrow(LayoutLinksError);
    try {
      checkLayoutLinks([{ path: 'node_modules/.bin', target: '../x' }], []);
    } catch (error) {
      expect(error).toMatchObject({ code: 'LAYOUT_LINKS_INVALID' });
    }
  });
});

describe('places', () => {
  it('turns a chain into a place and back', () => {
    expect(placePath(['a'])).toBe('node_modules/a');
    expect(placePath(['@s/a', 'b'])).toBe('node_modules/@s/a/node_modules/b');
    expect(chainOfPlace('node_modules/@s/a/node_modules/b')).toEqual([
      '@s/a',
      'b',
    ]);
    expect(chainOfPlace('node_modules/a')).toEqual(['a']);
  });

  it.each([
    '',
    'a',
    'node_modules',
    'node_modules/@s',
    'node_modules/a/b',
    'x/node_modules/a',
  ])('reads %j as no place', (path) => {
    expect(chainOfPlace(path)).toBeUndefined();
  });
});

describe('linkTargetBetween', () => {
  it.each([
    ['node_modules/member', 'packages/member', '../packages/member'],
    ['node_modules/@scope/member', 'packages/member', '../../packages/member'],
    [
      'node_modules/@scope/member',
      'packages/@scope/member',
      '../../packages/@scope/member',
    ],
    ['node_modules/h/node_modules/m', 'packages/m', '../../../packages/m'],
    ['node_modules/member', './packages/member', '../packages/member'],
  ])('from %s to %s is %s', (path, memberPath, expected) => {
    expect(linkTargetBetween(path, memberPath)).toBe(expected);
  });

  it('gives targets the project-io rules accept', () => {
    const path = 'node_modules/@scope/member';
    const target = linkTargetBetween(path, 'packages/member');
    expect(problemsOf([{ path, target }])).toEqual([]);
  });
});

describe('the planners carry links', () => {
  it('planLayout and planLayoutFromPaths return the checked links with the placements', () => {
    const links = [member];

    const planned = planLayout([layoutEntry('a')], { links });
    const fromPaths = planLayoutFromPaths([place('a')], { links });

    expect(planned.links).toEqual(links);
    expect(fromPaths.links).toEqual(links);
    expect(planned.placements.map((placement) => placement.chain)).toEqual([
      ['a'],
    ]);
  });

  it('plans no links unless asked, and the packages are placed as before', () => {
    expect(planLayout([layoutEntry('a')]).links).toEqual([]);
    expect(planLayoutFromPaths([place('a')]).links).toEqual([]);
  });

  it('refuses a plan whose link would take an installed name', () => {
    const links = [{ path: 'node_modules/a', target: '../packages/a' }];
    expect(() => planLayout([layoutEntry('a')], { links })).toThrow(
      /would replace the package the plan installs there/u,
    );
    expect(() => planLayoutFromPaths([place('a')], { links })).toThrow(
      LayoutLinksError,
    );
  });

  it('places packages and links together when they do not meet', () => {
    const plan = planLayout([layoutEntry('a'), layoutEntry('b')], {
      links: [member, { path: 'node_modules/m2', target: '../packages/m2' }],
    });
    expect(
      plan.placements.map((placement) => placement.chain.join('>')),
    ).toEqual(['a', 'b']);
    expect(plan.links.map((link) => link.path)).toEqual([
      'node_modules/@scope/member',
      'node_modules/m2',
    ]);
  });
});
