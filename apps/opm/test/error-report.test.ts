import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_CAUSE_DEPTH,
  formatFailure,
  parseFailure,
  scrub,
} from '../src/error-report.js';
import { EXIT_CODES as OPM_EXIT_CODES, runOpm } from '../src/opm.js';
import { EXIT_CODES as OPMX_EXIT_CODES, runOpmx } from '../src/opmx.js';
import { unsafeIn } from './terminal-fixture.js';

const PROXIED = { HTTPS_PROXY: 'http://user:hunter2@proxy.example:3128' };

function report(
  error: Error | string,
  env: Record<string, string | undefined> = {},
  internalError = true,
): string {
  return formatFailure(parseFailure(error), {
    tool: 'opm',
    internalError,
    env,
  });
}

function fault(message: string, code: string, cause?: Error): Error {
  return Object.assign(new Error(message, { cause }), { code });
}

/** What undici throws for a refused connection. */
function refused(): TypeError {
  return new TypeError('fetch failed', {
    cause: fault('connect ECONNREFUSED 127.0.0.1:443', 'ECONNREFUSED'),
  });
}

describe('formatFailure', () => {
  it('prints an error with no cause exactly as before', () => {
    expect(report(new Error('boom'))).toBe('opm: internal error: boom\n');
    expect(report(new Error('boom'), {}, false)).toBe('opm: boom\n');
    expect(report('a thrown string')).toBe(
      'opm: internal error: a thrown string\n',
    );
  });

  it('surfaces the cause of a failed fetch', () => {
    expect(report(refused())).toBe(
      [
        'opm: internal error: fetch failed',
        'opm:   caused by: Error: connect ECONNREFUSED 127.0.0.1:443',
        '',
      ].join('\n'),
    );
  });

  it('names a code the message does not carry', () => {
    const error = new TypeError('fetch failed', {
      cause: fault('Connect Timeout Error', 'UND_ERR_CONNECT_TIMEOUT'),
    });
    expect(report(error)).toContain(
      'caused by: Error: Connect Timeout Error [UND_ERR_CONNECT_TIMEOUT]',
    );
  });

  it('follows at most three causes, nested one level deeper each', () => {
    let error = new Error('level 5');
    for (const level of [4, 3, 2, 1])
      error = new Error(`level ${level}`, { cause: error });
    const lines = report(error).trimEnd().split('\n');
    expect(MAX_CAUSE_DEPTH).toBe(3);
    expect(lines).toEqual([
      'opm: internal error: level 1',
      'opm:   caused by: Error: level 2',
      'opm:     caused by: Error: level 3',
      'opm:       caused by: Error: level 4',
    ]);
  });

  it('stops on a cause that loops back', () => {
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    Object.assign(first, { cause: second });
    expect(report(first).trimEnd().split('\n')).toEqual([
      'opm: internal error: first',
      'opm:   caused by: Error: second',
    ]);
  });

  it('reads causes that are not errors', () => {
    expect(
      report(new Error('outer', { cause: 'ECONNRESET while reading' })),
    ).toContain('caused by: ECONNRESET while reading');
    const object = new Error('outer', {
      cause: { name: 'ProxyError', message: 'tunnel refused', code: 'E_PROXY' },
    });
    expect(report(object)).toContain(
      'caused by: ProxyError: tunnel refused [E_PROXY]',
    );
    expect(report(new Error('outer', { cause: 42 }))).toBe(
      'opm: internal error: outer\n',
    );
  });

  it('lists what an AggregateError gathered, and how many more', () => {
    const members = [1, 2, 3, 4, 5].map((n) =>
      fault(`connect ECONNREFUSED 10.0.0.${n}:443`, 'ECONNREFUSED'),
    );
    const error = new TypeError('fetch failed', {
      cause: new AggregateError(members, ''),
    });
    const line = report(error).split('\n')[1] ?? '';
    expect(line).toContain('AggregateError');
    expect(line).toContain('connect ECONNREFUSED 10.0.0.1:443');
    expect(line).toContain('connect ECONNREFUSED 10.0.0.3:443');
    expect(line).not.toContain('10.0.0.4');
    expect(line).toContain('+2 more');
  });

  it('keeps each cause to one bounded line', () => {
    const error = new Error('outer', {
      cause: new Error(`first\nsecond\n${'x'.repeat(2000)}`),
    });
    const lines = report(error).trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]?.length).toBeLessThan(340);
    expect(lines[1]).toContain('first second');
    expect(lines[1]?.endsWith('…')).toBe(true);
  });

  it('leaves an error that carries a code as the one line it always was', () => {
    const coded = fault('registry said no', 'POLICY_DENIED', refused());
    expect(report(coded)).toBe('opm: registry said no\n');
    expect(
      formatFailure(parseFailure(coded), { tool: 'opmx', env: PROXIED }),
    ).toBe('opmx: registry said no\n');
  });

  it('words an opmx failure without "internal error"', () => {
    expect(
      formatFailure(parseFailure(refused()), { tool: 'opmx', env: {} }),
    ).toBe(
      'opmx: fetch failed\nopmx:   caused by: Error: connect ECONNREFUSED 127.0.0.1:443\n',
    );
  });

  it('leaves no character a terminal acts on in what opmx prints, coded or not', () => {
    // An OSC that sets the title, BEL, CR, DEL, CSI (C1), a right-to-left
    // override, a zero-width space and a line separator, in a message and a cause.
    const hostile = 'a\u001b]0;PWN\u0007\r\u007f\u009b2J\u202eb\u200b\u2028c';
    const coded = Object.assign(new Error(hostile), { code: 'NOT_FOUND' });
    const uncoded = new Error(hostile, { cause: new Error(hostile) });
    for (const error of [coded, uncoded]) {
      const text = formatFailure(parseFailure(error), {
        tool: 'opmx',
        env: {},
      });
      expect(text.startsWith('opmx: a')).toBe(true);
      // Made plain (`report`, `plainText`): the title-setting sequence is
      // removed whole, with what it would have set, and the rest is kept.
      expect(text).not.toContain('PWN');
      expect(text).toContain('2Jb');
      expect(unsafeIn(text)).toEqual([]);
    }
  });
});

describe('proxy hint', () => {
  const hint = (text: string) =>
    text.split('\n').filter((line) => line.includes('hint:'));

  it('appears once for a connection fault under an unused proxy variable', () => {
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY']) {
      const lines = hint(report(refused(), { [name]: 'http://proxy:3128' }));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`${name} is set`);
      expect(lines[0]).toContain('NODE_USE_ENV_PROXY=1');
      expect(lines[0]).toContain('Node 22.21+');
    }
  });

  it('never prints the proxy URL, which can carry credentials', () => {
    const text = report(refused(), PROXIED);
    expect(text).toContain('hint:');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('proxy.example');
  });

  it('is absent once NODE_USE_ENV_PROXY is set', () => {
    expect(
      hint(report(refused(), { ...PROXIED, NODE_USE_ENV_PROXY: '1' })),
    ).toEqual([]);
  });

  it('treats an empty NODE_USE_ENV_PROXY or proxy variable as unset', () => {
    expect(
      hint(report(refused(), { ...PROXIED, NODE_USE_ENV_PROXY: '' })),
    ).toHaveLength(1);
    expect(hint(report(refused(), { HTTPS_PROXY: '' }))).toEqual([]);
  });

  it('is absent with no proxy variable', () => {
    expect(hint(report(refused(), {}))).toEqual([]);
  });

  it('is absent when the cause is not a connection fault', () => {
    const badPort = new TypeError('fetch failed', {
      cause: new Error('bad port'),
    });
    expect(hint(report(badPort, PROXIED))).toEqual([]);
    expect(hint(report(new Error('boom'), PROXIED))).toEqual([]);
  });

  it('recognises the faults of a wrapped or foreign cause', () => {
    for (const cause of [
      fault('getaddrinfo ENOTFOUND registry.npmjs.org', 'ENOTFOUND'),
      fault('read ECONNRESET', 'ECONNRESET'),
      fault('Connect Timeout Error', 'UND_ERR_CONNECT_TIMEOUT'),
      Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
      new Error('Proxy response (502) !== 200 when HTTP Tunneling'),
      new AggregateError(
        [fault('connect ETIMEDOUT 1.2.3.4:443', 'ETIMEDOUT')],
        '',
      ),
    ])
      expect(
        hint(report(new TypeError('fetch failed', { cause }), PROXIED)),
      ).toHaveLength(1);
  });

  it('looks at the whole chain, not only the nearest cause', () => {
    const error = new Error('outer', {
      cause: new Error('middle', { cause: refused().cause }),
    });
    expect(hint(report(error, PROXIED))).toHaveLength(1);
  });
});

describe('scrub', () => {
  it('keeps a URL to its origin and path', () => {
    expect(
      scrub('GET https://user:pw@registry.example/a/b?token=abc#frag failed'),
    ).toBe('GET https://registry.example/a/b failed');
    expect(scrub('via socks5://u:p@proxy.example:1080/ then')).toBe(
      'via socks5://proxy.example:1080/ then',
    );
  });

  it('withholds the value after a credential name', () => {
    expect(scrub('NPM_TOKEN=npm_abcdef123456 rejected')).toBe(
      'NPM_TOKEN=[REDACTED] rejected',
    );
    expect(scrub('Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA==')).toBe(
      'Proxy-Authorization: [REDACTED]',
    );
    expect(scrub('headers { authorization: Bearer abcdef0123456789 }')).toBe(
      'headers { authorization: [REDACTED] }',
    );
    expect(scrub('password=hunter2, retrying')).toBe(
      'password=[REDACTED], retrying',
    );
  });

  it('withholds a bare bearer token', () => {
    expect(scrub('server echoed Bearer abcdef0123456789xyz')).toBe(
      'server echoed Bearer [REDACTED]',
    );
  });

  it('leaves ordinary text alone', () => {
    const text =
      'connect ECONNREFUSED 127.0.0.1:443 (Unexpected token < in JSON)';
    expect(scrub(text)).toBe(text);
  });

  it('is applied to the headline and to every cause', () => {
    const error = new Error('GET https://u:p@host.example/x?k=v failed', {
      cause: new Error('echo Authorization: Bearer abcdef0123456789 rejected'),
    });
    const text = report(error);
    expect(text).toContain('GET https://host.example/x failed');
    expect(text).toContain('Authorization: [REDACTED]');
    for (const secret of ['u:p', 'k=v', 'abcdef0123456789'])
      expect(text).not.toContain(secret);
  });
});

describe('opm and opmx on a refused connection', () => {
  const temps: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  /** A loopback port nothing listens on, so the refusal is real and local. */
  async function closedPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await new Promise<void>((done) => server.close(() => done()));
    return port;
  }

  async function isolate(env: Record<string, string | undefined>) {
    const home = await mkdtemp(join(tmpdir(), 'opm-error-report-'));
    temps.push(home);
    vi.stubEnv('OPM_PLUGIN_HOME', home);
    vi.stubEnv('OPM_AUTH_CONFIG', join(home, 'auth.json'));
    vi.stubEnv('OPM_TOOL_CACHE', join(home, 'cache'));
    vi.stubEnv('OPM_REGISTRY_NPM', `https://127.0.0.1:${await closedPort()}`);
    for (const name of [
      'HTTPS_PROXY',
      'https_proxy',
      'HTTP_PROXY',
      'http_proxy',
      'NODE_USE_ENV_PROXY',
    ])
      vi.stubEnv(name, env[name] ?? '');
    return home;
  }

  function capture() {
    const chunks = { out: '', err: '' };
    return {
      chunks,
      io: {
        stdout: { write: (text: string) => ((chunks.out += text), true) },
        stderr: { write: (text: string) => ((chunks.err += text), true) },
      },
    };
  }

  it('opm explains the refusal and keeps exit code 9', async () => {
    const home = await isolate({});
    const cap = capture();
    const exit = await runOpm(['versions', 'pkg:npm/is-odd'], cap.io, home);
    expect(exit).toBe(OPM_EXIT_CODES.internal);
    const lines = cap.chunks.err.trimEnd().split('\n');
    expect(lines[0]).toBe('opm: internal error: fetch failed');
    expect(lines[1]).toMatch(
      /^opm: {3}caused by: Error: connect ECONNREFUSED 127\.0\.0\.1:\d+$/u,
    );
    expect(lines).toHaveLength(2);
  });

  it('opm adds the proxy hint when a proxy variable is set and unused', async () => {
    const home = await isolate(PROXIED);
    const cap = capture();
    const exit = await runOpm(['versions', 'pkg:npm/is-odd'], cap.io, home);
    expect(exit).toBe(OPM_EXIT_CODES.internal);
    expect(cap.chunks.err).toContain('ECONNREFUSED');
    expect(cap.chunks.err).toContain('opm: hint: HTTPS_PROXY is set');
    expect(cap.chunks.err).not.toContain('hunter2');
  });

  it('opm leaves the hint out once NODE_USE_ENV_PROXY is set', async () => {
    const home = await isolate({ ...PROXIED, NODE_USE_ENV_PROXY: '1' });
    const cap = capture();
    await runOpm(['versions', 'pkg:npm/is-odd'], cap.io, home);
    expect(cap.chunks.err).toContain('ECONNREFUSED');
    expect(cap.chunks.err).not.toContain('hint:');
  });

  it('opmx explains the refusal and keeps exit code 9', async () => {
    const home = await isolate(PROXIED);
    const cap = capture();
    const exit = await runOpmx(['pkg:npm/is-odd'], cap.io, home);
    expect(exit).toBe(OPMX_EXIT_CODES.internal);
    const lines = cap.chunks.err.trimEnd().split('\n');
    expect(lines[0]).toBe('opmx: fetch failed');
    expect(lines[1]).toMatch(
      /^opmx: {3}caused by: Error: connect ECONNREFUSED/u,
    );
    expect(lines[2]).toMatch(/^opmx: hint: HTTPS_PROXY is set/u);
  });
});
