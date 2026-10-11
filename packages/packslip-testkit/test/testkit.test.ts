import { describe, expect, it } from 'vitest';
import {
  FakeWeb,
  buildList,
  buildRelease,
  fakeFetch,
  generateTestKey,
  githubWorld,
  pae,
  signBundle,
  withPayload,
} from '../src/index.js';

describe('the packslip testkit', () => {
  it('encodes a DSSE pre-authentication string as the specification defines it', () => {
    expect(
      pae('application/vnd.in-toto+json', Buffer.from('{}')).toString(),
    ).toBe('DSSEv1 28 application/vnd.in-toto+json 2 {}');
  });

  it('writes a minisign-shaped public key and a matching hint', () => {
    const key = generateTestKey();
    const [comment, line] = key.publicKeyFile.trim().split('\n');
    expect(comment).toBe(`untrusted comment: minisign public key ${key.keyId}`);
    expect(Buffer.from(line ?? '', 'base64')).toHaveLength(42);
    expect(key.keyId).toMatch(/^[0-9A-F]{16}$/u);
    expect(key.hint).toMatch(/^[A-Za-z0-9+/]{43}=$/u);
  });

  it('signs a bundle whose payload can be swapped without touching its signature', () => {
    const key = generateTestKey();
    const bundle = JSON.parse(
      Buffer.from(signBundle({ a: 1 }, key)).toString(),
    );
    const swapped = JSON.parse(
      Buffer.from(
        withPayload(Buffer.from(JSON.stringify(bundle)), { a: 2 }),
      ).toString(),
    );
    expect(swapped.dsseEnvelope.signatures).toEqual(
      bundle.dsseEnvelope.signatures,
    );
    expect(swapped.dsseEnvelope.payload).not.toBe(bundle.dsseEnvelope.payload);
  });

  it('builds a release whose archives hash to the digests it signed', () => {
    const key = generateTestKey();
    const built = buildRelease({
      project: 'example.com/tool',
      version: '1.2.3',
      key,
    });
    expect(built.archives.size).toBe(1);
    expect(built.tag).toBe('v1.2.3');
    expect(built.bundleSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('scripts GitHub and answers anything else with 404', async () => {
    const key = generateTestKey();
    const web = new FakeWeb();
    githubWorld(web, {
      repo: 'acme/tool',
      releases: [
        {
          tag: 'v1.0.0',
          release: buildRelease({
            project: 'github.com/acme/tool',
            version: '1.0.0',
            key,
          }),
        },
      ],
      list: buildList({
        project: 'github.com/acme/tool',
        key,
        sequence: 1,
        entries: [],
      }),
    });
    const fetcher = fakeFetch(web);
    const releases = await fetcher(
      'https://api.github.com/repos/acme/tool/releases?per_page=100&page=1',
    );
    expect(releases.status).toBe(200);
    expect((await releases.json())[0].tag_name).toBe('v1.0.0');
    expect((await fetcher('https://example.com/nothing')).status).toBe(404);
    expect(web.requests).toHaveLength(2);
  });
});
