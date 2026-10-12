import { describe, expect, it } from 'vitest';
import { OciRegistryClient } from './index.js';
import { parseOciPurl } from './provider.js';

/**
 * What a message says of text from an OCI registry is one line: its error body,
 * the media type it names, the digest of a descriptor.
 */

const ESC = '\u001b';
const BEL = '\u0007';
const FORGED = `\nopm: internal error: forged\n  - b: forged\n${ESC}[2K${BEL}\nopm: ok installed 1 package`;

function holdsControl(text: string): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028;
  });
}

function client(respond: (url: string) => Response) {
  return new OciRegistryClient({
    registry: 'https://registry.example',
    repository: 'openpacker/demo',
    maximumAttempts: 1,
    // SAFETY: a stand-in for the network, which answers what the test says.
    fetch: (async (input: URL | string) =>
      respond(String(input))) as typeof fetch,
  });
}

async function messageOf<T>(run: () => Promise<T>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) return error.message;
  }
  throw new Error('nothing was thrown');
}

describe('what a registry says when it refuses', () => {
  it('is one line, however it words the body', async () => {
    const message = await messageOf(() =>
      client(
        () => new Response(`denied${FORGED}`, { status: 400 }),
      ).pullManifest('latest'),
    );
    expect(message).toMatch(/^Registry returned HTTP 400: denied/u);
    expect(holdsControl(message)).toBe(false);
  });

  it('is cut at 1,024 characters of the body, and says how long it was', async () => {
    const message = await messageOf(() =>
      client(
        () => new Response('x'.repeat(5000), { status: 400 }),
      ).pullManifest('latest'),
    );
    expect(message).toBe(`Registry returned HTTP 400: ${'x'.repeat(1024)}`);
  });

  it('says the same of an ordinary body as before', async () => {
    const message = await messageOf(() =>
      client(
        () => new Response('{"errors":[{"code":"DENIED"}]}', { status: 403 }),
      ).pullManifest('latest'),
    );
    expect(message).toBe(
      'Registry returned HTTP 403: {"errors":[{"code":"DENIED"}]}',
    );
  });
});

describe('a package URL that is not an OCI reference', () => {
  it.each([
    ['a tag', `pkg:oci/library/alpine:bad${ESC}[2K${BEL}`],
    ['a repository', `pkg:oci/Library/ALPINE${ESC}[2K${BEL}`],
    ['a registry', `pkg:oci/alpine?repository_url=http://x${ESC}[2K${BEL}`],
  ])('is one line: %s', (_, purl) => {
    let message = '';
    try {
      parseOciPurl(purl);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).not.toBe('');
    expect(holdsControl(message)).toBe(false);
  });
});
