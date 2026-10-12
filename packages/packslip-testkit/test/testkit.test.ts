import { describe, expect, it } from 'vitest';
import {
  FakeWeb,
  buildList,
  buildRelease,
  fakeFetch,
  generateTestKey,
  generateTestLog,
  githubWorld,
  pae,
  signBundle,
  signLoggedBundle,
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

  it('writes a throwaway log, and a bundle it recorded with a signed time and a proof', () => {
    const key = generateTestKey();
    const log = generateTestLog();
    expect(JSON.parse(log.trustedRoot).tlogs).toHaveLength(1);
    const at = new Date('2026-10-01T08:30:00Z');
    const [entry] = JSON.parse(
      Buffer.from(signLoggedBundle({ a: 1 }, key, log, at)).toString(),
    ).verificationMaterial.tlogEntries;
    expect(entry.integratedTime).toBe(String(at.getTime() / 1000));
    expect(entry.inclusionPromise.signedEntryTimestamp).toBeTruthy();
    expect(entry.inclusionProof).toMatchObject({ treeSize: '1', hashes: [] });
    // A forgery writes another time into the entry and leaves the signature alone.
    const claimed = JSON.parse(
      Buffer.from(
        signLoggedBundle(
          { a: 1 },
          key,
          log,
          at,
          new Date('2020-01-01T00:00:00Z'),
        ),
      ).toString(),
    ).verificationMaterial.tlogEntries[0];
    expect(claimed.integratedTime).toBe(
      String(Date.parse('2020-01-01T00:00:00Z') / 1000),
    );
    // The log's signature is over the real time, so it cannot vouch for this one.
    expect(claimed.inclusionPromise.signedEntryTimestamp).toBeTruthy();
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
