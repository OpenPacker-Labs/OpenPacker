/**
 * Every text the tests of `apps/opm` sent through `scrub` when the list was
 * taken (a run of the whole suite with the input of each call recorded, repeats
 * removed): the cases of `error-report.test.ts`, `error-text.test.ts` and
 * `error-lines.test.ts`, as `scrub` receives them after the writer has made
 * them plain. `scrub-differential.test.ts` holds the new `scrub` to the first
 * version's answer on each. The long message of the line-length test is
 * written out where it is used.
 */
export const EXISTING_VECTORS: readonly string[] = [
  'first\n  second',
  'failed:\n  token=hunter2\n',
  'Error: a  b',
  'outer',
  'boom',
  'a thrown string',
  'Error: connect ECONNREFUSED 127.0.0.1:443',
  'fetch failed',
  'Error: Connect Timeout Error [UND_ERR_CONNECT_TIMEOUT]',
  'Error: level 2',
  'Error: level 3',
  'Error: level 4',
  'level 1',
  'Error: second',
  'first',
  'ECONNRESET while reading',
  'ProxyError: tunnel refused [E_PROXY]',
  'AggregateError (connect ECONNREFUSED 10.0.0.1:443; connect ECONNREFUSED 10.0.0.2:443; connect ECONNREFUSED 10.0.0.3:443; +2 more)',
  'TypeError: fetch failed',
  'Error: bad port',
  'Error: getaddrinfo ENOTFOUND registry.npmjs.org',
  'Error: read ECONNRESET',
  'Error: other side closed [UND_ERR_SOCKET]',
  'Error: Proxy response (502) !== 200 when HTTP Tunneling',
  'AggregateError (connect ETIMEDOUT 1.2.3.4:443)',
  'Error: middle',
  'GET https://user:pw@registry.example/a/b?token=abc#frag failed',
  'via socks5://u:p@proxy.example:1080/ then',
  'NPM_TOKEN=npm_abcdef123456 rejected',
  'Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA==',
  'headers { authorization: Bearer abcdef0123456789 }',
  'password=hunter2, retrying',
  'server echoed Bearer abcdef0123456789xyz',
  'connect ECONNREFUSED 127.0.0.1:443 (Unexpected token < in JSON)',
  'Error: echo Authorization: Bearer abcdef0123456789 rejected',
  'GET https://u:p@host.example/x?k=v failed',
  'Error: connect ECONNREFUSED 127.0.0.1:35311',
  'failed on dep x',
  'Error: dep x',
  'password=hunter2',
  'see https://u:CANARY@h/p now',
  `Error: first second ${'x'.repeat(2000)}`,
];
