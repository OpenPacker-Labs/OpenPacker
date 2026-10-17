import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatDepPath, packageKeyOf, parseDepPath } from './dep-path.js';
import { PnpmLockError } from './errors.js';
import { DEFAULT_PNPM_LOCK_LIMITS } from './limits.js';

const parse = (text: string) =>
  parseDepPath(text, DEFAULT_PNPM_LOCK_LIMITS, 'snapshots');

/**
 * pnpm 10.28.0's own split, copied from `@pnpm/dependency-path` (MIT) as
 * bundled in pnpm.cjs (`indexOfDepPathSuffix`, `parse`, `removeSuffix`),
 * without its semver check: the oracle the generated keys are compared with.
 */
function indexOfDepPathSuffix(depPath: string) {
  if (!depPath.endsWith(')')) return { peersIndex: -1, patchHashIndex: -1 };
  let open = 1;
  for (let i = depPath.length - 2; i >= 0; i--) {
    if (depPath[i] === '(') open--;
    else if (depPath[i] === ')') open++;
    else if (!open) {
      if (depPath.substring(i + 1).startsWith('(patch_hash='))
        return {
          patchHashIndex: i + 1,
          peersIndex: depPath.indexOf('(', i + 2),
        };
      return { patchHashIndex: -1, peersIndex: i + 1 };
    }
  }
  return { peersIndex: -1, patchHashIndex: -1 };
}

function pnpmParse(dependencyPath: string) {
  const sepIndex = dependencyPath.indexOf('@', 1);
  const name = dependencyPath.substring(0, sepIndex);
  let version = dependencyPath.substring(sepIndex + 1);
  let peerDepGraphHash: string | undefined;
  let patchHash: string | undefined;
  const { peersIndex, patchHashIndex } = indexOfDepPathSuffix(version);
  if (peersIndex !== -1 || patchHashIndex !== -1) {
    if (peersIndex === -1) {
      patchHash = version.substring(patchHashIndex);
      version = version.substring(0, patchHashIndex);
    } else if (patchHashIndex === -1) {
      peerDepGraphHash = version.substring(peersIndex);
      version = version.substring(0, peersIndex);
    } else {
      patchHash = version.substring(patchHashIndex, peersIndex);
      peerDepGraphHash = version.substring(peersIndex);
      version = version.substring(0, patchHashIndex);
    }
  }
  return { name, version, peerDepGraphHash, patchHash };
}

function pnpmRemoveSuffix(depPath: string): string {
  const { peersIndex, patchHashIndex } = indexOfDepPathSuffix(depPath);
  if (patchHashIndex !== -1) return depPath.substring(0, patchHashIndex);
  if (peersIndex !== -1) return depPath.substring(0, peersIndex);
  return depPath;
}

interface Model {
  name: string;
  version: string;
  patchHash?: string;
  peers: Model[];
  peersHash?: string;
}

const word = fc.stringMatching(/^[a-z0-9][a-z0-9._~+-]{0,8}$/u);
const nameArb = fc
  .oneof(
    word,
    fc.tuple(word, word).map(([scope, base]) => `@${scope}/${base}`),
  )
  .filter((name) => !name.includes('node_modules'));
const SHA = '0123456789abcdef0123456789abcdef01234567';
const identifier = fc.stringMatching(/^[0-9A-Za-z-]{1,5}$/u).filter(
  // numeric identifiers may not have leading zeros
  (part) => !/^0\d+$/u.test(part),
);
const versionArb = fc.oneof(
  {
    weight: 6,
    arbitrary: fc
      .tuple(
        fc.nat(30),
        fc.nat(30),
        fc.nat(30),
        fc.option(fc.array(identifier, { minLength: 1, maxLength: 2 }), {
          nil: undefined,
        }),
        fc.option(
          fc.array(fc.stringMatching(/^[0-9A-Za-z-]{1,4}$/u), {
            minLength: 1,
            maxLength: 2,
          }),
          { nil: undefined },
        ),
      )
      .map(
        ([major, minor, patch, pre, build]) =>
          `${major}.${minor}.${patch}${pre ? `-${pre.join('.')}` : ''}${build ? `+${build.join('.')}` : ''}`,
      ),
  },
  { weight: 1, arbitrary: word.map((dir) => `file:../${dir}`) },
  { weight: 1, arbitrary: word.map((dir) => `https://h.example/${dir}.tgz`) },
  {
    weight: 1,
    arbitrary: word.map((dir) => `git+https://h.example/${dir}.git#${SHA}`),
  },
  { weight: 1, arbitrary: fc.constant('runtime:22.0.0') },
);

const patchArb = fc.option(fc.stringMatching(/^[a-z0-9]{8,26}$/u), {
  nil: undefined,
});
const hashArb = fc.option(fc.stringMatching(/^[0-9a-f]{32}$/u), {
  nil: undefined,
});
const byDepth = new Map<number, fc.Arbitrary<Model>>();

/** Models up to `depth` levels of peers; built once per depth, because building an arbitrary is the slow part. */
function modelArb(depth: number): fc.Arbitrary<Model> {
  const known = byDepth.get(depth);
  if (known !== undefined) return known;
  const peers: fc.Arbitrary<Model[]> =
    depth === 0
      ? fc.constant([])
      : fc.array(
          fc.constant(depth - 1).chain((next) => modelArb(next)),
          { maxLength: 3 },
        );
  const built = fc
    .tuple(nameArb, versionArb, patchArb, peers, hashArb)
    .map(([name, version, patchHash, list, hash]) => ({
      name,
      version,
      ...(patchHash !== undefined && { patchHash }),
      peers: hash === undefined ? list : [],
      ...(hash !== undefined && { peersHash: hash }),
    }));
  byDepth.set(depth, built);
  return built;
}

function textOf(model: Model): string {
  const patch =
    model.patchHash === undefined ? '' : `(patch_hash=${model.patchHash})`;
  const peers =
    model.peersHash === undefined
      ? model.peers.map((peer) => `(${textOf(peer)})`).join('')
      : `(${model.peersHash})`;
  return `${model.name}@${model.version}${patch}${peers}`;
}

function modelOf(path: ReturnType<typeof parse>): Model {
  return {
    name: path.name,
    version: path.version,
    ...(path.patchHash !== undefined && { patchHash: path.patchHash }),
    peers: path.peers.map(modelOf),
    ...(path.peersHash !== undefined && { peersHash: path.peersHash }),
  };
}

const keys = modelArb(3);

describe('parseDepPath: properties', () => {
  it('reads back exactly the name, version, patch hash and peers a key was built from', () => {
    fc.assert(
      fc.property(keys, (model) => {
        const text = textOf(model);
        expect(modelOf(parse(text))).toEqual(model);
        expect(formatDepPath(parse(text))).toBe(text);
        expect(parse(text).raw).toBe(text);
      }),
      { numRuns: 1500 },
    );
  });

  it('splits where pnpm splits: name, version, patch group, peers suffix and package key', () => {
    fc.assert(
      fc.property(keys, (model) => {
        const text = textOf(model);
        const ours = parse(text);
        const theirs = pnpmParse(text);
        expect(ours.name).toBe(theirs.name);
        expect(ours.version).toBe(theirs.version);
        expect(
          ours.patchHash === undefined
            ? undefined
            : `(patch_hash=${ours.patchHash})`,
        ).toBe(theirs.patchHash);
        const suffix =
          ours.peersHash !== undefined
            ? `(${ours.peersHash})`
            : ours.peers.map((peer) => `(${formatDepPath(peer)})`).join('');
        expect(suffix === '' ? undefined : suffix).toBe(
          theirs.peerDepGraphHash,
        );
        expect(packageKeyOf(ours)).toBe(pnpmRemoveSuffix(text));
      }),
      { numRuns: 1500 },
    );
  });

  it('refuses a key with one parenthesis taken out or put in', () => {
    const withParens = keys.filter((model) => textOf(model).includes('('));
    fc.assert(
      fc.property(withParens, fc.nat(), fc.boolean(), (model, pick, remove) => {
        const text = textOf(model);
        const at = [...text].flatMap((c, i) =>
          c === '(' || c === ')' ? [i] : [],
        );
        const index = at[pick % at.length]!;
        const broken = remove
          ? text.slice(0, index) + text.slice(index + 1)
          : text.slice(0, index) +
            (text[index] === '(' ? ')' : '(') +
            text.slice(index);
        expect(() => parse(broken)).toThrow(PnpmLockError);
      }),
      { numRuns: 1500 },
    );
  });

  it('only ever parses to something that formats back to the same text, or refuses with a PnpmLockError', () => {
    const noisy = fc.oneof(
      fc.string({ maxLength: 40 }),
      fc.stringMatching(/^[@a-z0-9.()+:/#&=_-]{0,50}$/u),
      keys
        .map((model) => textOf(model))
        .chain((text) =>
          fc
            .nat(Math.max(text.length - 1, 0))
            .map((cut) => text.slice(0, cut) + text.slice(cut + 1)),
        ),
    );
    fc.assert(
      fc.property(noisy, (text) => {
        let path: ReturnType<typeof parse>;
        try {
          path = parse(text);
        } catch (error) {
          expect(error).toBeInstanceOf(PnpmLockError);
          return;
        }
        expect(formatDepPath(path)).toBe(text);
      }),
      { numRuns: 4000 },
    );
  });
});
