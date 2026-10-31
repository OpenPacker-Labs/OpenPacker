import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETAINED_BYTES,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from '@openpacker/adapter-core';
import { parseCanonicalJsonCosted } from '@openpacker/canonical';
import {
  MemoizingTransport,
  providerForWithDiscovery,
  resolveManifestToLock,
} from '../src/index.js';
import {
  NPM_ORIGIN,
  NpmRegistryFixture,
  type FixturePackage,
} from './npm-registry-fixture.js';
import { manifestFor } from './resolver-scenarios.js';

/**
 * A packument's bytes are held twice, by the memo (the response) and by the
 * provider (the objects parsed from it, and the same bytes). They have one
 * owner: while the provider holds a document, the memo's entry for it is part
 * of the provider's, counted once and let go with it. So a budget never lets
 * the memo go of a document the provider still uses, which would free nothing
 * and send the provider's next use of it to the origin, where a registry that
 * published in between makes the resolve stop.
 */

const NOW = () => '2026-08-04T00:00:00Z';
const ABBREVIATED = 'application/vnd.npm.install-v1+json';
const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

const heavy = (name: string, bytes: number, versions: string[]) =>
  ({
    name,
    versions: Object.fromEntries(versions.map((version) => [version, {}])),
    padding: { bytes, only: 'abbreviated' },
  }) satisfies FixturePackage;

/**
 * A registry with etags, which answers a validator it gave with a 304, records
 * what reached it, and can publish: after it serves `publishAfter`, it serves
 * the documents of `after`.
 */
class Origin implements HttpTransport {
  readonly refetchable = true;
  readonly asked: string[] = [];
  #published = false;
  constructor(
    private readonly before: NpmRegistryFixture,
    private readonly after = before,
    private readonly publishAfter?: string,
  ) {}

  async request(request: HttpRequest): Promise<HttpResponse> {
    const { 'if-none-match': validator, ...headers } = request.headers ?? {};
    const fixture = this.#published ? this.after : this.before;
    const response = await fixture.request({ ...request, headers });
    if (request.url.endsWith('.tgz')) return response;
    const name = decodeURIComponent(request.url.slice(NPM_ORIGIN.length + 1));
    this.asked.push(validator === undefined ? name : `${name} (validator)`);
    if (name === this.publishAfter) this.#published = true;
    const etag = `"${sha256(response.body)}"`;
    if (validator === etag)
      return {
        status: 304,
        headers: { etag },
        body: new Uint8Array(),
        url: request.url,
      };
    return { ...response, headers: { ...response.headers, etag } };
  }
}

/** What the provider counts a packument at: its tree's estimate and its text. */
async function weightOf(registry: NpmRegistryFixture, name: string) {
  const { body } = await registry.request({
    url: `${NPM_ORIGIN}/${name}`,
    headers: { accept: ABBREVIATED },
  });
  const { retained } = parseCanonicalJsonCosted(new TextDecoder().decode(body));
  return { provider: retained + body.byteLength, memo: body.byteLength };
}

describe('a registry that publishes while a resolve reads it', () => {
  const before = new NpmRegistryFixture([
    heavy('a', 300_000, ['1.0.0']),
    heavy('b', 300_000, ['1.0.0']),
  ]);
  const after = new NpmRegistryFixture([
    heavy('a', 300_000, ['1.0.0', '1.1.0']),
    heavy('b', 300_000, ['1.0.0']),
  ]);

  async function resolveAt(maximumRetainedBytes: number) {
    const origin = new Origin(before, after, 'b');
    const root = await mkdtemp(join(tmpdir(), 'opm-owner-'));
    try {
      const lock = await resolveManifestToLock({
        root,
        manifest: manifestFor(['a', 'b']),
        offline: false,
        registryOptions: { transport: origin, maximumRetainedBytes, now: NOW },
      });
      return { lock, asked: origin.asked };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it('locks the same whatever the budget, while the provider holds what it read', async () => {
    const a = await weightOf(before, 'a');
    const b = await weightOf(before, 'b');
    // Room for both trees and their text counted once, and not for the text
    // counted a second time for the memo.
    const pressed = a.provider + b.provider + Math.floor(a.memo / 2);
    const unlimited = await resolveAt(Number.POSITIVE_INFINITY);
    expect(Object.keys(unlimited.lock.packages)).toHaveLength(2);
    for (const budget of [DEFAULT_RETAINED_BYTES, pressed]) {
      const other = await resolveAt(budget);
      expect(JSON.stringify(other.lock), `a budget of ${budget}`).toBe(
        JSON.stringify(unlimited.lock),
      );
      // Every later use was answered from memory: the origin saw each
      // packument once, and no validator.
      expect(other.asked).toEqual(unlimited.asked);
    }
    expect(unlimited.asked).toEqual(['a', 'b']);
  });

  it('stops, naming the package, when it kept nothing and the registry changed it', async () => {
    await expect(resolveAt(0)).rejects.toMatchObject({
      code: 'STALE_METADATA',
      message:
        'The registry changed the packument of a during the resolve; run it again',
    });
  });
});

/** A small deterministic generator, so a failure names the step it fails at. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('a provider that still holds a document', () => {
  const names = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
  const registry = new NpmRegistryFixture(
    names.map((name, index) => heavy(name, 40_000 + index * 37_000, ['1.0.0'])),
  );

  it('never sends a use of it to the origin, whatever the budget and however the reads interleave', async () => {
    let total = 0;
    for (const name of names)
      total += (await weightOf(registry, name)).provider;
    const mean = total / names.length;
    for (const budget of [
      0,
      mean,
      2.5 * mean,
      5 * mean,
      Number.POSITIVE_INFINITY,
    ]) {
      const origin = new Origin(registry);
      const memo = new MemoizingTransport(origin, {
        maximumRetainedBytes: Math.floor(budget),
      });
      const provider = await providerForWithDiscovery('npm', {
        transport: memo,
        now: NOW,
      });
      const next = random(7);
      for (let step = 0; step < 60; step += 1) {
        const asked = Array.from(
          { length: 1 + Math.floor(next() * 3) },
          () => names[Math.floor(next() * names.length)]!,
        );
        // Asked together, so one's answer can arrive before another's tree is
        // parsed.
        await Promise.all(
          asked.map((name) => provider.enumerate(`pkg:npm/${name}`)),
        );
        // A provider sends a validator only for a document whose tree it
        // holds; the memo holds that document too, and answers it.
        expect(
          origin.asked.filter((what) => what.endsWith('(validator)')),
          `budget ${Math.floor(budget)}, step ${step}`,
        ).toEqual([]);
        expect(memo.retention.retainedBytes).toBeLessThanOrEqual(
          Math.floor(budget),
        );
      }
    }
  });
});
