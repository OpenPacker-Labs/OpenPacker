import { describe, expect, it } from 'vitest';
import type { HttpRequest, HttpResponse } from '@openpacker/adapter-core';
import { defaultAdapterModules } from '@openpacker/adapters-default';
import { handleError } from '../src/opm.js';
import { capture } from './capture.js';

/**
 * A registry cannot add a line to what opm writes. A document's text reaches an
 * error through the adapter that read it, so each adapter makes the text it
 * repeats one line where it repeats it (`echoed`, in @openpacker/adapter-core),
 * and the writer keeps the line feeds of opm's own lists. Here a hostile
 * document is read by the real adapter and the error it raises is written by
 * the real handler: whatever the document says, one error is one line.
 */

const ESC = '\u001b';
const BEL = '\u0007';
/**
 * Lines that look like opm's own, a list entry, and an erase. It holds no `]`,
 * `;` or `,`, which the parsers split on, so the text reaches the message.
 */
const FORGED =
  `\nopm: internal error: forged\n  - pkg:npm/b@1: forged\n` +
  `${ESC}[2K${BEL}\nopm: ok installed 1 package`;

/** The same without `/` or `@`, which a version is not allowed to hold. */
const FORGED_VERSION =
  `\nopm: internal error: forged\n  - b: forged\n` +
  `${ESC}[2K${BEL}\nopm: ok installed 1 package`;

type Body = string | Record<string, unknown> | unknown[];

function adapter(id: string, respond: (url: string) => Body) {
  const module = defaultAdapterModules().find(
    (candidate) => candidate.id === `org.openpacker.adapter.${id}`,
  );
  const catalog = module?.catalog?.({
    transport: {
      async request(request: HttpRequest): Promise<HttpResponse> {
        const body = respond(request.url);
        return {
          status: 200,
          headers: {},
          body: new TextEncoder().encode(
            typeof body === 'string' ? body : JSON.stringify(body),
          ),
          url: request.url,
        };
      },
    },
    now: () => '2026-10-12T00:00:00Z',
  });
  if (catalog === undefined) throw new Error(`no ${id} adapter`);
  return catalog;
}

/** What the CLI writes of the error `run` ends with. */
async function written<T>(run: () => Promise<T>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const cap = capture();
    handleError(error, cap.io);
    return cap.err;
  }
  throw new Error('the document was accepted');
}

/** The one line an error is, with the line feed the writer ends it with. */
function expectOneLine(err: string): void {
  expect(err.endsWith('\n')).toBe(true);
  expect(err.slice(0, -1)).not.toContain('\n');
  expect(err).not.toContain(ESC);
  expect(err).not.toContain('forged\n');
  expect(err.startsWith('opm: ')).toBe(true);
}

describe('a hostile document read by the PyPI adapter', () => {
  const file = (name: string) => ({
    filename: name,
    packagetype: 'sdist',
    url: `https://files.example.test/${encodeURIComponent(name)}`,
    digests: { sha256: 'a'.repeat(64) },
    upload_time_iso_8601: '2026-01-01T00:00:00Z',
    size: 10,
  });
  const document = (requirement: string, version = '1.0.0') => ({
    info: {
      name: 'evilpy',
      version,
      requires_dist: [requirement],
      requires_python: null,
    },
    releases: { [version]: [file('evilpy-1.0.0.tar.gz')] },
    urls: [],
  });

  it.each([
    ['extras that never close', `dep[x${FORGED}`],
    ['a name that is not one', `-${FORGED}`],
    ['a specifier that is not one', `dep >=${FORGED}`],
    ['a version that is not one', `dep ==1.0${ESC}[2K${BEL}`],
    ['a prefix match that is not allowed', `dep >1.*${ESC}[2K${BEL}`],
  ])('is one line when a requirement has %s', async (_, requirement) => {
    const pypi = adapter('pypi', () => document(requirement));
    expectOneLine(await written(() => pypi.inspect('pkg:pypi/evilpy@1.0.0')));
  });

  it('is one line when a release is named by something that is not a version', async () => {
    const pypi = adapter('pypi', () => document('dep', `2.0${FORGED_VERSION}`));
    expectOneLine(await written(() => pypi.enumerate('pkg:pypi/evilpy')));
  });
});
