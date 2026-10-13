import { describe, expect, it } from 'vitest';
import {
  RetentionLedger,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from '@openpacker/adapter-core';
import { NpmRegistryProvider } from './index.js';

/**
 * A provider keeps the packuments it has read so that a package is parsed once.
 * Under a budget it lets go of the objects of the least recently used and reads
 * them again through its transport, and what it says it read (the snapshot) does
 * not change: the digest of each document stays after its objects go.
 */

const ENDPOINT = 'https://registry.test';
const encoder = new TextEncoder();

/** A registry of packuments, with etags, that counts what it was asked. */
class Registry implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  readonly retention: RetentionLedger;
  /** Full documents served, as against the 304s. */
  documents = 0;
  revision = 0;
  constructor(
    readonly refetchable: boolean | undefined,
    budget: number,
    private readonly names: readonly string[],
  ) {
    this.retention = new RetentionLedger(budget);
  }

  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const name = decodeURIComponent(request.url.slice(ENDPOINT.length + 1));
    if (!this.names.includes(name)) throw new Error(`no ${name}`);
    const etag = `"${name}-${this.revision}"`;
    if (request.headers?.['if-none-match'] === etag)
      return {
        status: 304,
        headers: { etag },
        body: new Uint8Array(),
        url: request.url,
      };
    this.documents += 1;
    const body = encoder.encode(
      JSON.stringify({
        name,
        'dist-tags': { latest: '1.0.0' },
        modified: '2026-01-01T00:00:00.000Z',
        versions: {
          [`1.${this.revision}.0`]: { name, version: `1.${this.revision}.0` },
          '1.0.0': { name, version: '1.0.0' },
        },
        pad: 'x'.repeat(2_000),
      }),
    );
    return { status: 200, headers: { etag }, body, url: request.url };
  }
}

const provider = (registry: Registry) =>
  new NpmRegistryProvider(
    registry,
    { now: () => '2026-10-12T00:00:00Z' },
    ENDPOINT,
  );

describe('a provider under a retention budget', () => {
  it('reads a packument once, and revalidates it with its etag, while it keeps it', async () => {
    const registry = new Registry(true, 1_000_000, ['a']);
    const npm = provider(registry);
    await npm.enumerate('pkg:npm/a');
    await npm.enumerate('pkg:npm/a');
    expect(
      registry.requests.map((request) => request.headers?.['if-none-match']),
    ).toEqual([undefined, '"a-0"']);
    expect(registry.retention.entries).toBe(1);
  });

  it('lets go of the least recently used, and reads it again with no validator', async () => {
    // Two packuments are about 2.3 KB of text each and a few KB to parse: a
    // budget for one and a half.
    const registry = new Registry(true, 5_000, ['a', 'b']);
    const npm = provider(registry);
    await npm.enumerate('pkg:npm/a');
    await npm.enumerate('pkg:npm/b');
    expect(registry.retention.evictions).toBeGreaterThan(0);
    await npm.enumerate('pkg:npm/a');
    expect(
      registry.requests.map((request) => request.url.split('/').at(-1)),
    ).toEqual(['a', 'b', 'a']);
    // Let go, so asked for afresh: nothing to revalidate.
    expect(registry.requests[2]!.headers?.['if-none-match']).toBeUndefined();
    expect(registry.retention.retainedBytes).toBeLessThanOrEqual(5_000);
  });

  it('keeps nothing with a budget of zero and still answers', async () => {
    const registry = new Registry(true, 0, ['a']);
    const npm = provider(registry);
    for (let read = 0; read < 3; read += 1)
      expect(await npm.enumerate('pkg:npm/a')).toEqual(['pkg:npm/a@1.0.0']);
    expect(registry.requests).toHaveLength(3);
    expect(registry.retention.retainedBytes).toBe(0);
  });

  it('says the same about what it read, whatever it kept', async () => {
    const names = ['a', 'b', 'c'];
    const evidence = async (budget: number) => {
      const registry = new Registry(true, budget, names);
      const npm = provider(registry);
      for (const name of [...names, 'a', 'c', 'b'])
        await npm.enumerate(`pkg:npm/${name}`);
      return { snapshot: await npm.snapshot('2026-10-12T00:00:00Z'), registry };
    };
    const unlimited = await evidence(Number.POSITIVE_INFINITY);
    const nothing = await evidence(0);
    const small = await evidence(5_000);
    // Kept, a second read is a 304; let go, it is the whole document again.
    expect(unlimited.registry.documents).toBe(3);
    expect(nothing.registry.documents).toBe(6);
    expect(small.registry.retention.evictions).toBeGreaterThan(0);
    expect(nothing.snapshot).toEqual(unlimited.snapshot);
    expect(small.snapshot).toEqual(unlimited.snapshot);
  });

  it('reads a packument that is not held once, however many ask while it is read', async () => {
    const registry = new Registry(true, 0, ['a']);
    const npm = provider(registry);
    const answers = await Promise.all([
      npm.enumerate('pkg:npm/a'),
      npm.enumerate('pkg:npm/a'),
      npm.enumerate('pkg:npm/a'),
    ]);
    expect(answers[0]).toEqual(answers[1]);
    // Not three fetches and three trees of what a budget of nothing let go.
    expect(registry.requests).toHaveLength(1);
    // Asked again once it is read, it is read again: nothing is held.
    await npm.enumerate('pkg:npm/a');
    expect(registry.requests).toHaveLength(2);
  });

  it('stops when a packument it let go comes back different', async () => {
    const registry = new Registry(true, 0, ['a']);
    const npm = provider(registry);
    await npm.enumerate('pkg:npm/a');
    registry.revision = 1;
    await expect(npm.enumerate('pkg:npm/a')).rejects.toMatchObject({
      code: 'STALE_METADATA',
      message:
        'The packument of a changed while the resolve was running; run it again',
    });
  });

  it('forgets a packument it was told to invalidate, with no check of what comes next', async () => {
    const registry = new Registry(true, 0, ['a']);
    const npm = provider(registry);
    await npm.enumerate('pkg:npm/a');
    registry.revision = 1;
    npm.invalidate('pkg:npm/a');
    expect(await npm.enumerate('pkg:npm/a')).toContain('pkg:npm/a@1.1.0');
  });

  it.each([[undefined], [false]])(
    'keeps everything on a transport that cannot be asked again (refetchable: %s)',
    async (refetchable) => {
      const registry = new Registry(refetchable, 0, ['a', 'b']);
      const npm = provider(registry);
      for (const name of ['a', 'b', 'a', 'b'])
        await npm.enumerate(`pkg:npm/${name}`);
      expect(registry.retention.evictions).toBe(0);
      // The two revalidations carry their etags, as they did before there was a budget.
      expect(
        registry.requests.filter(
          (request) => request.headers?.['if-none-match'],
        ),
      ).toHaveLength(2);
    },
  );
});
