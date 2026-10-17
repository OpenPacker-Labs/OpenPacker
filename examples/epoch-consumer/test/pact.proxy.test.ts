import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startEpochPactProvider } from '../src/provider-fixture.js';
import {
  verifyEpochPact,
  withoutProxyForLoopback,
} from '../src/pact-provider.js';

/**
 * The Pact verifier's own proxy sends every provider request through
 * `HTTPS_PROXY || HTTP_PROXY` and never reads NO_PROXY, so with a proxy
 * configured a loopback provider was asked through it, and a proxy elsewhere
 * cannot reach this host's loopback. These configure a proxy that reaches
 * nothing; nothing may be sent through it.
 */

const UNREACHABLE = 'http://proxy.invalid:3128';
const NAMES = ['HTTPS_PROXY', 'HTTP_PROXY'] as const;
const before = Object.fromEntries(
  NAMES.map((name) => [name, process.env[name]]),
);

let provider: Awaited<ReturnType<typeof startEpochPactProvider>>;
beforeAll(async () => {
  provider = await startEpochPactProvider();
});
afterAll(async () => provider.close());
afterEach(() => {
  for (const name of NAMES)
    if (before[name] === undefined) delete process.env[name];
    else process.env[name] = before[name];
});

function configureUnreachableProxy() {
  for (const name of NAMES) process.env[name] = UNREACHABLE;
}

describe('Pact verification of a loopback provider', () => {
  it('reaches the provider directly while a proxy is configured', async () => {
    configureUnreachableProxy();
    await verifyEpochPact({
      providerBaseUrl: provider.address,
      logLevel: 'error',
    });
    for (const name of NAMES) expect(process.env[name]).toBe(UNREACHABLE);
  });

  it('hides the proxy only from a loopback request, and only while it runs', async () => {
    configureUnreachableProxy();
    const seen = () => NAMES.map((name) => process.env[name]);
    for (const url of [
      'http://127.0.0.1:1',
      'http://127.8.0.1:1',
      'http://localhost:1',
      'http://[::1]:1',
    ])
      expect(await withoutProxyForLoopback(url, async () => seen())).toEqual([
        undefined,
        undefined,
      ]);
    for (const url of ['https://provider.example', 'http://10.0.0.1:1'])
      expect(await withoutProxyForLoopback(url, async () => seen())).toEqual([
        UNREACHABLE,
        UNREACHABLE,
      ]);
    expect(seen()).toEqual([UNREACHABLE, UNREACHABLE]);
  });

  it('puts the proxy back once the last of overlapping requests ends, even one that fails', async () => {
    configureUnreachableProxy();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withoutProxyForLoopback('http://127.0.0.1:1', () => held);
    await expect(
      withoutProxyForLoopback('http://127.0.0.1:2', async () => {
        throw new Error('the second request failed');
      }),
    ).rejects.toThrow('the second request failed');
    expect(process.env.HTTPS_PROXY).toBeUndefined();
    release();
    await first;
    for (const name of NAMES) expect(process.env[name]).toBe(UNREACHABLE);
  });
});
