import { describe, expect, it } from 'vitest';
import { npmPackageRuns, npmTargetPredicate } from './platform.js';

const hosts = {
  linux: { os: 'linux', architecture: 'x64', libc: 'glibc' },
  musl: { os: 'linux', architecture: 'arm64', libc: 'musl' },
  mac: { os: 'darwin', architecture: 'arm64' },
  windows: { os: 'win32', architecture: 'x64' },
} as const;

describe('npmPackageRuns', () => {
  const table: [
    string,
    { os?: string[]; cpu?: string[]; libc?: string[] },
    Record<keyof typeof hosts, boolean>,
  ][] = [
    [
      'no constraint',
      {},
      { linux: true, musl: true, mac: true, windows: true },
    ],
    [
      'plain os',
      { os: ['linux'] },
      { linux: true, musl: true, mac: false, windows: false },
    ],
    [
      'two os',
      { os: ['linux', 'darwin'] },
      { linux: true, musl: true, mac: true, windows: false },
    ],
    [
      'negated os',
      { os: ['!win32'] },
      { linux: true, musl: true, mac: true, windows: false },
    ],
    [
      'two negated',
      { os: ['!win32', '!darwin'] },
      { linux: true, musl: true, mac: false, windows: false },
    ],
    [
      'a plain entry and its own negation',
      { os: ['linux', '!linux'] },
      { linux: false, musl: false, mac: false, windows: false },
    ],
    [
      'any',
      { os: ['any'], cpu: ['any'] },
      { linux: true, musl: true, mac: true, windows: true },
    ],
    [
      'cpu',
      { cpu: ['arm64'] },
      { linux: false, musl: true, mac: true, windows: false },
    ],
    [
      'os and cpu together',
      { os: ['linux'], cpu: ['x64'] },
      { linux: true, musl: false, mac: false, windows: false },
    ],
    [
      'glibc',
      { os: ['linux'], libc: ['glibc'] },
      { linux: true, musl: false, mac: false, windows: false },
    ],
    [
      'musl',
      { os: ['linux'], cpu: ['arm64'], libc: ['musl'] },
      { linux: false, musl: true, mac: false, windows: false },
    ],
    [
      'libc alone on a host with no libc to report',
      { libc: ['glibc'] },
      { linux: true, musl: false, mac: true, windows: true },
    ],
  ];

  for (const [label, declared, expected] of table)
    it(label, () => {
      for (const [host, target] of Object.entries(hosts))
        expect(npmPackageRuns(declared, target), `${label} on ${host}`).toBe(
          expected[host as keyof typeof hosts],
        );
    });
});

describe('npmTargetPredicate', () => {
  it('states nothing for an empty or "any" list', () => {
    expect(npmTargetPredicate(undefined, undefined, undefined)).toBeUndefined();
    expect(npmTargetPredicate([], [], [])).toBeUndefined();
    expect(npmTargetPredicate(['any'], undefined, undefined)).toBeUndefined();
  });

  it('keeps plain and negated entries as the two clauses they are', () => {
    expect(
      npmTargetPredicate(['linux', '!darwin'], undefined, undefined),
    ).toEqual({
      type: 'allOf',
      predicates: [
        { type: 'in', path: 'os', values: ['linux'] },
        { type: 'notIn', path: 'os', values: ['darwin'] },
      ],
    });
  });
});
