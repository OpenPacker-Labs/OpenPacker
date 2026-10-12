import { describe, expect, it } from 'vitest';
import { FixtureHttpTransport } from '@openpacker/adapter-core';
import { PypiJsonProvider, parsePep508Requirement } from './index.js';

/**
 * What a message says of text from a PyPI document is one line. The text is a
 * registry's: a requirement, a marker, an extra, `requires_python`, a file name.
 */

const ESC = '\u001b';
const BEL = '\u0007';
const FORGED = `\nopm: internal error: forged\n  - b: forged\n${ESC}[2K${BEL}\nopm: ok installed 1 package`;

function provider(document: unknown) {
  const url = 'https://fixtures.test/evilpy/json';
  return new PypiJsonProvider(
    new FixtureHttpTransport(
      new Map([
        [
          url,
          {
            status: 200,
            headers: {},
            body: new TextEncoder().encode(JSON.stringify(document)),
          },
        ],
      ]),
    ),
    { now: () => '2026-10-12T00:00:00Z' },
    'https://fixtures.test',
  );
}

function holdsControl(text: string): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028;
  });
}

/** Every `originalMeaning`, `omittedMeaning` and `representedMeaning` a result carries. */
function lossTexts(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) lossTexts(item, found);
  else if (typeof value === 'object' && value !== null)
    for (const [key, entry] of Object.entries(value)) {
      if (key.endsWith('Meaning') && typeof entry === 'string')
        found.push(entry);
      else lossTexts(entry, found);
    }
  return found;
}

function messageOf(run: () => void): string {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error.message;
  }
  throw new Error('nothing was thrown');
}

describe('a requirement the parser refuses', () => {
  it.each([
    ['too long', `dep${FORGED}`.padEnd(5000, 'x')],
    ['without a name', `-${FORGED}`],
    ['with extras that never close', `dep[x${FORGED}`],
  ])('is one line when it is %s', (_, requirement) => {
    const message = messageOf(() => parsePep508Requirement(requirement));
    expect(holdsControl(message)).toBe(false);
    // 256 characters of it, and how long it was.
    expect(message.length).toBeLessThan(400);
  });

  it('reads an ordinary one as it always did', () => {
    expect(messageOf(() => parsePep508Requirement('dep[x'))).toBe(
      'Unclosed extras in requirement: dep[x',
    );
  });
});

describe('what is recorded of a document that is not understood', () => {
  const file = (filename: string, complete = true) => ({
    filename,
    packagetype: 'sdist',
    url: 'https://files.example.test/evilpy-1.0.0.tar.gz',
    ...(complete
      ? { digests: { sha256: 'a'.repeat(64) }, size: 10 }
      : { digests: {} }),
    upload_time_iso_8601: '2026-01-01T00:00:00Z',
  });
  const document = {
    info: {
      name: 'evilpy',
      version: '1.0.0',
      requires_dist: [
        `dep[extra${FORGED.replaceAll('\n', ' ')}]; python_version < "3.8"${FORGED}`,
      ],
      requires_python: `>=3.8${FORGED}`,
    },
    releases: { '1.0.0': [file(`evilpy${FORGED}.tar.gz`, false)] },
    urls: [],
  };

  it('says nothing that is more than a line of it', async () => {
    const inspection = await provider(document).inspect(
      'pkg:pypi/evilpy@1.0.0',
    );
    const texts = lossTexts(inspection);
    expect(texts.length).toBeGreaterThanOrEqual(4);
    for (const text of texts) expect(holdsControl(text), text).toBe(false);
  });
});
