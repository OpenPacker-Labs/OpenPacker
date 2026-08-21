import { describe, expect, it } from 'vitest';
import type { HttpRequest, HttpResponse } from '@openpacker/adapter-core';
import { checkServiceability, isStale } from '../src/serviceability.js';

const NOW = '2026-08-10T00:00:00.000Z';
const now = () => NOW;

/** A transport that answers each URL with a status, headers, or a throw. */
function answering(
  routes: Record<
    string,
    { status: number; headers?: Record<string, string> } | Error
  >,
) {
  const seen: string[] = [];
  const transport = {
    async request(request: HttpRequest): Promise<HttpResponse> {
      seen.push(request.url);
      const answer = routes[request.url];
      if (answer === undefined) throw new Error('no route');
      if (answer instanceof Error) throw answer;
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      return {
        status: answer.status,
        headers: answer.headers ?? {},
        body: new Uint8Array(),
        url: request.url,
      } as HttpResponse;
    },
  };
  return { transport, seen };
}

const check = (
  routes: Parameters<typeof answering>[0],
  locations: string[],
  extra: { size?: number } = {},
) =>
  checkServiceability({
    locations,
    transport: answering(routes).transport,
    now,
    ...extra,
  });

describe('serviceability classification', () => {
  it('calls a reachable artifact verified', async () => {
    const record = await check(
      { 'https://cdn.example/a.tgz': { status: 200 } },
      ['https://cdn.example/a.tgz'],
    );
    expect(record.state).toBe('verified');
  });

  it.each([401, 402, 403, 407])(
    'treats %i as gated, because it is running and wants credentials',
    async (status) => {
      // 26.5% of the endpoints in the MCP survey answer this way. A check that
      // reads non-200 as failure condemns a quarter of a registry — and the
      // surveyor's own false positive was the 402, which is why it is here.
      const record = await check({ 'https://paid.example/a.tgz': { status } }, [
        'https://paid.example/a.tgz',
      ]);
      expect(record.state).toBe('gated');
    },
  );

  it.each([500, 502, 503, 504])(
    'leaves %i unchecked rather than blaming the package',
    async (status) => {
      const record = await check(
        { 'https://flaky.example/a.tgz': { status } },
        ['https://flaky.example/a.tgz'],
      );
      // A bad day at the origin is not a durable fact about the package.
      expect(record.state).toBe('unchecked');
    },
  );

  it('leaves a connection failure unchecked, not unreachable', async () => {
    const record = await check(
      { 'https://gone.example/a.tgz': new Error('ETIMEDOUT') },
      ['https://gone.example/a.tgz'],
    );
    // Evidence about the network between here and there, not about the package.
    expect(record.state).toBe('unchecked');
    expect(record.detail).toContain('ETIMEDOUT');
  });

  it.each([404, 410])('calls %i unreachable', async (status) => {
    const record = await check({ 'https://cdn.example/a.tgz': { status } }, [
      'https://cdn.example/a.tgz',
    ]);
    expect(record.state).toBe('unreachable');
  });

  it('catches a live host serving something other than the artifact', async () => {
    // The exact failure the survey measured: a 200 from a page where the
    // artifact used to be. A status check alone would call this verified.
    const record = await check(
      {
        'https://cdn.example/a.tgz': {
          status: 200,
          headers: { 'content-length': '4213' },
        },
      },
      ['https://cdn.example/a.tgz'],
      { size: 91_204 },
    );
    expect(record.state).toBe('unreachable');
    expect(record.detail).toContain('4213');
  });

  it('says which check actually happened', async () => {
    const withLength = await check(
      {
        'https://cdn.example/a.tgz': {
          status: 200,
          headers: { 'content-length': '10' },
        },
      },
      ['https://cdn.example/a.tgz'],
      { size: 10 },
    );
    expect(withLength.method).toBe('head');

    const withoutLength = await check(
      { 'https://cdn.example/a.tgz': { status: 200 } },
      ['https://cdn.example/a.tgz'],
    );
    // Reachable is not the same claim as "these are the right bytes".
    expect(withoutLength.method).toBe('status');
    expect(withoutLength.detail).toContain('not identified');
  });

  it('stops at the first location that answers', async () => {
    const { transport, seen } = answering({
      'https://a.example/x': { status: 200 },
      'https://b.example/x': { status: 200 },
    });
    await checkServiceability({
      locations: ['https://a.example/x', 'https://b.example/x'],
      transport,
      now,
    });
    // A package mirrored three ways is reachable if any answers; probing all
    // of them costs three times as much for no more certainty.
    expect(seen).toEqual(['https://a.example/x']);
  });

  it('is unchecked, not unreachable, when there is nothing to check', async () => {
    const record = await checkServiceability({
      locations: [],
      transport: answering({}).transport,
      now,
    });
    expect(record.state).toBe('unchecked');
    expect(record.method).toBe('none');
  });
});

describe('staleness', () => {
  it('treats an absent or unparseable record as due', () => {
    expect(isStale(undefined, 1000, 0)).toBe(true);
    expect(
      isStale(
        { state: 'verified', checkedAt: 'not a date', method: 'head' },
        1000,
        0,
      ),
    ).toBe(true);
  });

  it('holds a fresh record and releases an expired one', () => {
    const record = {
      state: 'verified' as const,
      checkedAt: '2026-08-10T00:00:00.000Z',
      method: 'head' as const,
    };
    const at = Date.parse(record.checkedAt);
    expect(isStale(record, 1000, at + 999)).toBe(false);
    expect(isStale(record, 1000, at + 1000)).toBe(true);
  });
});
