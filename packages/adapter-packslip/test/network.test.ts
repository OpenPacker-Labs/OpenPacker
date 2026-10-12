import { describe, expect, it } from 'vitest';
import type { HostLookup } from '@openpacker/adapter-core';
import { createNetwork } from '../src/index.js';

function recorder(respond: (url: URL) => Response) {
  const seen: { url: string; headers: Headers }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    seen.push({ url: url.href, headers: new Headers(init?.headers) });
    return respond(url);
  };
  return { seen, fetchImpl };
}

const answer =
  (address: string): HostLookup =>
  async () => [{ address, family: address.includes(':') ? 6 : 4 }];

describe('the network a provider uses', () => {
  it('returns statuses as answers, so a 404 can mean "no list"', async () => {
    const { fetchImpl } = recorder(() => new Response('nope', { status: 404 }));
    const response = await createNetwork({
      fetch: fetchImpl,
      lookup: answer('93.184.216.34'),
    }).get('https://dl.example.com/x', { maxBytes: 100 });
    expect(response.status).toBe(404);
  });

  it.each([
    ['loopback', '127.0.0.1'],
    ['a private network', '10.1.2.3'],
    ['link-local cloud metadata', '169.254.169.254'],
    ['IPv6 loopback', '::1'],
    ['an IPv4-mapped private address', '::ffff:10.0.0.1'],
  ])(
    'refuses a vendor URL whose name resolves to %s',
    async (_what, address) => {
      const { seen, fetchImpl } = recorder(() => new Response('ok'));
      await expect(
        createNetwork({ fetch: fetchImpl, lookup: answer(address) }).get(
          'https://internal.evil.example/x',
          {
            maxBytes: 100,
          },
        ),
      ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      expect(seen).toEqual([]);
    },
  );

  it('refuses plaintext and credential-bearing URLs', async () => {
    const network = createNetwork({
      fetch: recorder(() => new Response('ok')).fetchImpl,
      lookup: answer('93.184.216.34'),
    });
    await expect(
      network.get('http://dl.example.com/x', { maxBytes: 10 }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(
      network.get('https://user:pw@dl.example.com/x', { maxBytes: 10 }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(
      network.get('not a url', { maxBytes: 10 }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('lets a vendor URL redirect only within its own origin', async () => {
    const { seen, fetchImpl } = recorder((url) =>
      url.pathname === '/start'
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://cdn.elsewhere.example/file' },
          })
        : new Response('ok'),
    );
    await expect(
      createNetwork({ fetch: fetchImpl, lookup: answer('93.184.216.34') }).get(
        'https://dl.example.com/start',
        {
          maxBytes: 100,
        },
      ),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(seen.map((entry) => entry.url)).toEqual([
      'https://dl.example.com/start',
    ]);
  });

  it('lets a GitHub download follow GitHub’s redirect to its release CDN', async () => {
    const { seen, fetchImpl } = recorder((url) =>
      url.host === 'github.com'
        ? new Response(null, {
            status: 302,
            headers: {
              location:
                'https://release-assets.githubusercontent.com/blob?sig=1',
            },
          })
        : new Response('payload'),
    );
    const response = await createNetwork({
      fetch: fetchImpl,
      lookup: answer('140.82.112.3'),
    }).get('https://github.com/acme/tool/releases/download/v1/tool.tar.gz', {
      maxBytes: 100,
    });
    expect(Buffer.from(response.bytes).toString()).toBe('payload');
    expect(seen.map((entry) => new URL(entry.url).host)).toEqual([
      'github.com',
      'release-assets.githubusercontent.com',
    ]);
  });

  it('refuses a body larger than the caller allowed', async () => {
    const { fetchImpl } = recorder(() => new Response('x'.repeat(200)));
    await expect(
      createNetwork({ fetch: fetchImpl, lookup: answer('93.184.216.34') }).get(
        'https://dl.example.com/big',
        { maxBytes: 100 },
      ),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  describe('a GitHub token', () => {
    const TOKEN_ENV = 'PACKSLIP_TEST_GITHUB_TOKEN';

    it('travels by environment-variable name, to the API origin only', async () => {
      process.env[TOKEN_ENV] = 'ghp_abc123';
      try {
        const { seen, fetchImpl } = recorder(() => new Response('[]'));
        const network = createNetwork({
          fetch: fetchImpl,
          lookup: answer('140.82.112.5'),
          githubTokenEnv: TOKEN_ENV,
        });
        await network.get('https://api.github.com/repos/a/b/releases', {
          maxBytes: 100,
        });
        await network.get('https://github.com/a/b/releases/download/v1/x', {
          maxBytes: 100,
        });
        expect(seen[0]?.headers.get('authorization')).toBe('Bearer ghp_abc123');
        expect(seen[1]?.headers.get('authorization')).toBeNull();
      } finally {
        delete process.env[TOKEN_ENV];
      }
    });

    it('is an error, not a silent downgrade, when the named variable is unset', async () => {
      delete process.env[TOKEN_ENV];
      const { fetchImpl } = recorder(() => new Response('[]'));
      await expect(
        createNetwork({
          fetch: fetchImpl,
          lookup: answer('140.82.112.5'),
          githubTokenEnv: TOKEN_ENV,
        }).get('https://api.github.com/repos/a/b/releases', { maxBytes: 100 }),
      ).rejects.toMatchObject({
        code: 'UNAVAILABLE',
        message: expect.stringContaining(TOKEN_ENV),
      });
    });

    it('refuses a name that is not a variable name, so a token value is never mistaken for one', () => {
      expect(() => createNetwork({ githubTokenEnv: 'ghp_abc 123' })).toThrow(
        /environment variable/u,
      );
      expect(() => createNetwork({ githubTokenEnv: '1BAD' })).toThrow(
        /environment variable/u,
      );
    });

    it.each([
      // The shapes real GitHub tokens have: mixed case, so not a name.
      ['a classic token', 'ghp_AbCdEf0123456789AbCdEf0123456789AbCd'],
      [
        'a fine-grained token',
        'github_pat_11AABBCCDD0abcdefghijk_lmnopqrstuvwxyz0123456789',
      ],
      ['an OAuth token', 'gho_AbCdEf0123456789AbCdEf0123456789AbCd'],
      // Upper-cased, it would pass for a name; the prefix gives it away.
      [
        'a token that was upper-cased',
        'GHP_ABCDEF0123456789ABCDEF0123456789ABCD',
      ],
      ['a name that is too long to be one', 'A'.repeat(65)],
      ['a lowercase name', 'github_token'],
    ])(
      'refuses %s, and never repeats it, because it may be the token itself',
      (_label, pasted) => {
        let message = '';
        try {
          createNetwork({ githubTokenEnv: pasted });
        } catch (error) {
          message = String(error);
        }
        expect(message).toContain('environment variable');
        expect(message).not.toContain(pasted);
        expect(message.toLowerCase()).not.toContain(
          pasted.slice(0, 12).toLowerCase(),
        );
      },
    );

    it('accepts the conventional capitalised names', () => {
      for (const name of [
        'GITHUB_TOKEN',
        'GH_TOKEN',
        'OPM_GITHUB_TOKEN',
        '_X1',
      ])
        expect(() => createNetwork({ githubTokenEnv: name })).not.toThrow();
    });
  });
});
