import { describe, expect, it } from 'vitest';
import {
  NpmCodec,
  NpmRegistryProvider,
  type NpmVersionMetadata,
} from './index.js';

/**
 * A dependency's name and range come from a registry's document, and a message
 * about them goes to a terminal. They are named in plain text: an escape
 * sequence or a line break in either must not reach the message.
 */

const ESC = '\u001b';
const BEL = '\u0007';
/** A terminal control (C0, DEL, C1), or a line or paragraph separator. */
function holdsControl(text: string): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029
    );
  });
}

const provenance = {
  providerId: 'fixture',
  endpoint: 'https://fixtures.test',
  retrievedAt: '2026-08-02T00:00:00Z',
  evaluationTime: '2026-08-02T00:00:00Z',
  metadataDigest: { algorithm: 'sha256' as const, value: '1'.repeat(64) },
};

const translate = (metadata: Record<string, unknown>) =>
  new NpmCodec().translateMetadata(
    // SAFETY: a literal that carries the fields under test.
    { name: 'demo', version: '1.0.0', ...metadata } as NpmVersionMetadata,
    provenance,
  );

async function refusal(metadata: Record<string, unknown>): Promise<Error> {
  try {
    await translate(metadata);
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error('the package was accepted');
}

async function losses(metadata: Record<string, unknown>): Promise<string[]> {
  const { instance } = await translate(metadata);
  return [
    ...instance.semanticLoss,
    ...instance.requirements.flatMap(({ semanticLoss }) => semanticLoss),
  ].flatMap(({ originalMeaning, representedMeaning }) =>
    representedMeaning === undefined
      ? [originalMeaning]
      : [originalMeaning, representedMeaning],
  );
}

describe('a dependency the package cannot resolve', () => {
  it.each([
    [
      'a range with a title-setting escape sequence',
      { dep: `git+https://x.test/${ESC}]0;pwned${BEL}` },
      'demo@1.0.0 depends on dep as "git+https://x.test/", a git specifier ' +
        'that is not a registry version range',
    ],
    [
      'a name with a colour and a newline, and such a range',
      { [`dep${ESC}[31m\nx`]: `git+https://x.test/${ESC}[2K` },
      'demo@1.0.0 depends on depx as "git+https://x.test/", a git specifier ' +
        'that is not a registry version range',
    ],
    [
      'a tag with a colour in it',
      { dep: `lat${ESC}[31mest` },
      'demo@1.0.0 depends on dep as "latest", a tag specifier that is not a ' +
        'registry version range',
    ],
  ])('is named in plain text: %s', async (_, dependencies, message) => {
    const error = await refusal({ dependencies });
    expect(error).toMatchObject({
      code: 'UNSUPPORTED_DEPENDENCY_SPEC',
      message,
    });
  });

  it('says why an npm: alias is not one npm installs, in plain text', async () => {
    const error = await refusal({
      dependencies: {
        dep: `npm:foo@git+https://x.test/${ESC}]0;pwned${BEL}\nx`,
      },
    });
    expect(error).toMatchObject({ code: 'UNSUPPORTED_DEPENDENCY_SPEC' });
    expect(error.message).toContain(
      '(aliases only work for registry packages, and ',
    );
    expect(holdsControl(error.message)).toBe(false);
  });

  it('names the package in plain text too', async () => {
    const error = await refusal({
      name: `de${ESC}[31mmo`,
      dependencies: { dep: 'github:user/dep' },
    });
    expect(error.message).toBe(
      'demo@1.0.0 depends on dep as "github:user/dep", a git specifier that ' +
        'is not a registry version range',
    );
  });

  it('cuts a range of megabytes and says how long it was', async () => {
    const range = `git+https://x.test/${'a'.repeat(2 * 1024 * 1024)}`;
    const error = await refusal({ dependencies: { dep: range } });
    expect(error.message.length).toBeLessThan(400);
    expect(error.message).toContain(`… (${range.length} characters)`);
  });

  it('keeps ordinary messages byte for byte', async () => {
    expect(
      (await refusal({ dependencies: { bar: 'github:user/bar' } })).message,
    ).toBe(
      'demo@1.0.0 depends on bar as "github:user/bar", a git specifier that ' +
        'is not a registry version range',
    );
    expect(
      (await refusal({ peerDependencies: { '@scope/bar': 'latest' } })).message,
    ).toBe(
      'demo@1.0.0 depends on @scope/bar as "latest", a tag specifier that is ' +
        'not a registry version range',
    );
  });
});

describe('a dependency the package keeps without resolving', () => {
  it('has its range in plain text in what is recorded of it', async () => {
    const texts = await losses({
      devDependencies: { dep: `git+https://x.test/${ESC}]0;pwned${BEL}` },
    });
    expect(texts).toEqual([
      'The git specifier "git+https://x.test/" is not a registry version range',
      'The package is named without a version constraint and the specifier is retained verbatim',
    ]);
  });

  it('has its name and range in plain text when the name cannot be read', async () => {
    const texts = await losses({
      devDependencies: {
        [`dep${ESC}[31m\nx`]: `git+https://x.test/${ESC}]0;pwned${BEL}`,
      },
    });
    expect(texts).toEqual([
      'The devDependencies entry "depx": "git+https://x.test/" cannot be ' +
        'represented: Invalid npm coordinate: depx',
    ]);
  });

  it('is named in plain text when its name cannot be read at all', async () => {
    const texts = await losses({
      devDependencies: { [`bad ${ESC}[31mname\n`]: '^1' },
    });
    expect(texts).toHaveLength(1);
    expect(holdsControl(texts[0] ?? '')).toBe(false);
    expect(texts[0]).toContain('cannot be represented: Invalid npm coordinate');
  });

  it('keeps ordinary entries byte for byte', async () => {
    expect(await losses({ devDependencies: { bar: 'latest' } })).toEqual([
      'The tag specifier "latest" is not a registry version range',
      'The package is named without a version constraint and the specifier is retained verbatim',
    ]);
    expect(await losses({ devDependencies: { 'bad name': '^1' } })).toEqual([
      'The devDependencies entry "bad name": "^1" cannot be represented: Invalid npm coordinate: bad name',
    ]);
  });
});

describe('a registry that serves such a dependency', () => {
  const inspect = (dependencies: Record<string, string>) => {
    const document = {
      name: 'p',
      'dist-tags': { latest: '1.0.0' },
      modified: '2026-10-12T00:00:00.000Z',
      versions: {
        '1.0.0': {
          name: 'p',
          version: '1.0.0',
          dependencies,
          dist: { tarball: 'https://fixtures.test/p.tgz' },
        },
      },
    };
    const provider = new NpmRegistryProvider(
      {
        async request() {
          return {
            status: 200,
            headers: {},
            body: new TextEncoder().encode(JSON.stringify(document)),
            url: 'https://fixtures.test/p',
          };
        },
      },
      { now: () => '2026-10-12T00:00:00Z' },
      'https://fixtures.test',
    );
    return provider.inspect('pkg:npm/p@1.0.0');
  };

  it.each([
    ['a range', { dep: `git+https://x.test/${ESC}]0;pwned${BEL}` }],
    ['a name', { [`dep${ESC}[31m\nx`]: '^1' }],
  ])('is refused in plain text: %s', async (_, dependencies) => {
    const error = await inspect(dependencies).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect(holdsControl((error as Error).message)).toBe(false);
  });
});
