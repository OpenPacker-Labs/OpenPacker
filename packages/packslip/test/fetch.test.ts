import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PackslipError, createBoundedFetcher } from '../src/index.js';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

let server: Server;
let base = '';
const routes = new Map<string, Handler>();

beforeAll(async () => {
  server = createServer((request, response) => {
    const handler = routes.get(request.url ?? '');
    if (handler === undefined) {
      response.writeHead(404).end('nothing here');
      return;
    }
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const local = () =>
  createBoundedFetcher({ allowLoopbackHttp: true, timeoutMs: 2000 });

async function refusal(action: Promise<unknown>): Promise<PackslipError> {
  try {
    await action;
  } catch (error) {
    if (error instanceof PackslipError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('the bounded fetcher against a real server', () => {
  it('returns the status and body, including a 404 body, and an empty body for a server error', async () => {
    routes.set('/ok', (_req, res) => res.writeHead(200).end('hello'));
    routes.set('/boom', (_req, res) =>
      res.writeHead(500).end('secret stack trace'),
    );
    const fetcher = local();
    const ok = await fetcher.get(`${base}/ok`, { maxBytes: 100 });
    expect(ok.status).toBe(200);
    expect(Buffer.from(ok.bytes).toString()).toBe('hello');
    expect(
      (await fetcher.get(`${base}/missing`, { maxBytes: 100 })).status,
    ).toBe(404);
    const boom = await fetcher.get(`${base}/boom`, { maxBytes: 100 });
    expect(boom.status).toBe(500);
    expect(boom.bytes.byteLength).toBe(0);
  });

  it('refuses a body whose declared length is over the limit without reading it', async () => {
    let wrote = 0;
    routes.set('/declared', (_req, res) => {
      res.writeHead(200, { 'content-length': '1000000' });
      wrote += 1;
      res.write('x');
    });
    const error = await refusal(
      local().get(`${base}/declared`, { maxBytes: 1000 }),
    );
    expect(error.code).toBe('UNAVAILABLE');
    expect(error.message).toContain('over the 1000 byte limit');
    expect(wrote).toBe(1);
  });

  it('cuts off a chunked body that runs past the limit', async () => {
    routes.set('/chunked', (_req, res) => {
      res.writeHead(200, { 'transfer-encoding': 'chunked' });
      const timer = setInterval(() => res.write('x'.repeat(400)), 5);
      res.on('close', () => clearInterval(timer));
    });
    const error = await refusal(
      local().get(`${base}/chunked`, { maxBytes: 1000 }),
    );
    expect(error.message).toContain('over the 1000 byte limit');
  });

  it('follows redirects, one hop at a time', async () => {
    routes.set('/a', (_req, res) =>
      res.writeHead(302, { location: '/b' }).end(),
    );
    routes.set('/b', (_req, res) =>
      res.writeHead(301, { location: `${base}/c` }).end(),
    );
    routes.set('/c', (_req, res) => res.writeHead(200).end('arrived'));
    const response = await local().get(`${base}/a`, { maxBytes: 100 });
    expect(Buffer.from(response.bytes).toString()).toBe('arrived');
    expect(response.url).toBe(`${base}/c`);
  });

  it('gives up on a redirect loop', async () => {
    routes.set('/loop', (_req, res) =>
      res.writeHead(302, { location: '/loop' }).end(),
    );
    expect(
      (await refusal(local().get(`${base}/loop`, { maxBytes: 100 }))).message,
    ).toContain('redirected more than 5 times');
  });

  it('refuses a redirect without a location', async () => {
    routes.set('/nowhere', (_req, res) => res.writeHead(302).end());
    expect(
      (await refusal(local().get(`${base}/nowhere`, { maxBytes: 100 })))
        .message,
    ).toContain('without a location');
  });

  it('refuses to be redirected off HTTPS to a remote host', async () => {
    routes.set('/downgrade', (_req, res) =>
      res.writeHead(302, { location: 'http://example.com/payload' }).end(),
    );
    expect(
      (await refusal(local().get(`${base}/downgrade`, { maxBytes: 100 })))
        .message,
    ).toContain('Refusing to fetch over http:');
  });

  it('refuses to be redirected to a URL that carries credentials', async () => {
    routes.set('/creds', (_req, res) =>
      res.writeHead(302, { location: 'https://user:pass@example.com/x' }).end(),
    );
    expect(
      (await refusal(local().get(`${base}/creds`, { maxBytes: 100 }))).message,
    ).toContain('carries credentials');
  });

  it('reports an unreachable host as unavailable', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, '127.0.0.1', resolve),
    );
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    expect(
      (
        await refusal(
          local().get(`http://127.0.0.1:${port}/`, { maxBytes: 10 }),
        )
      ).code,
    ).toBe('UNAVAILABLE');
  });

  it('times out a server that never answers', async () => {
    routes.set('/hang', () => undefined);
    const fetcher = createBoundedFetcher({
      allowLoopbackHttp: true,
      timeoutMs: 50,
    });
    expect(
      (await refusal(fetcher.get(`${base}/hang`, { maxBytes: 10 }))).code,
    ).toBe('UNAVAILABLE');
  });
});

describe('what the fetcher will not talk to', () => {
  it('requires HTTPS, and allows loopback HTTP only when asked', async () => {
    const strict = createBoundedFetcher();
    expect(
      (await refusal(strict.get(`${base}/ok`, { maxBytes: 10 }))).message,
    ).toContain('http:');
    expect(
      (
        await refusal(
          createBoundedFetcher({ allowLoopbackHttp: true }).get(
            'http://example.com/',
            { maxBytes: 10 },
          ),
        )
      ).message,
    ).toContain('Refusing to fetch over http:');
    expect(
      (await refusal(strict.get('ftp://example.com/x', { maxBytes: 10 }))).code,
    ).toBe('UNAVAILABLE');
    expect(
      (await refusal(strict.get('file:///etc/passwd', { maxBytes: 10 }))).code,
    ).toBe('UNAVAILABLE');
  });

  it('refuses a URL with embedded credentials before connecting', async () => {
    const error = await refusal(
      createBoundedFetcher().get('https://user:pw@example.com/', {
        maxBytes: 10,
      }),
    );
    expect(error.message).toContain('credentials');
    expect(error.message).not.toContain('pw');
  });
});

describe('credentials', () => {
  function recording() {
    const seen: { url: string; authorization: string | null }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const headers = new Headers(init?.headers);
      seen.push({ url: url.href, authorization: headers.get('authorization') });
      if (url.hostname === 'api.github.com' && url.pathname === '/redirect')
        return new Response(null, {
          status: 302,
          headers: { location: 'https://example.com/elsewhere' },
        });
      return new Response('ok');
    };
    return { seen, fetchImpl };
  }

  it('sends a GitHub token to GitHub and to nobody else', async () => {
    const { seen, fetchImpl } = recording();
    const fetcher = createBoundedFetcher({
      fetch: fetchImpl,
      githubToken: 'ghp_secret',
    });
    await fetcher.get('https://api.github.com/repos/a/b/releases', {
      maxBytes: 100,
    });
    await fetcher.get('https://example.com/file', { maxBytes: 100 });
    expect(seen[0]?.authorization).toBe('Bearer ghp_secret');
    expect(seen[1]?.authorization).toBeNull();
  });

  it('drops the token when GitHub redirects somewhere else', async () => {
    const { seen, fetchImpl } = recording();
    const fetcher = createBoundedFetcher({
      fetch: fetchImpl,
      githubToken: 'ghp_secret',
    });
    await fetcher.get('https://api.github.com/redirect', { maxBytes: 100 });
    expect(seen.map((entry) => entry.authorization)).toEqual([
      'Bearer ghp_secret',
      null,
    ]);
    expect(seen[1]?.url).toBe('https://example.com/elsewhere');
  });

  it('asks for the media type it was given and identifies itself', async () => {
    const headers: Headers[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      headers.push(new Headers(init?.headers));
      return new Response('{}');
    };
    await createBoundedFetcher({
      fetch: fetchImpl,
      userAgent: 'test-agent',
    }).get('https://example.com/x', {
      maxBytes: 10,
      accept: 'application/vnd.github+json',
    });
    expect(headers[0]?.get('accept')).toBe('application/vnd.github+json');
    expect(headers[0]?.get('user-agent')).toBe('test-agent');
  });
});
