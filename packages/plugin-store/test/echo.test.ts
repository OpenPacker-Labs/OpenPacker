import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixtureHttpTransport } from '@openpacker/adapter-core';
import { configureAdapters } from '@openpacker/opm-project';
import {
  addPlugin,
  parsePluginSpec,
  pluginRegistryModule,
} from '../src/index.js';

/**
 * What a message says of a plugin registry's text, or of what its archive
 * holds, is one line. The registry is the operator's to name and a registry's
 * to word: an entry's name, a published digest, a location, the names inside
 * the archive it serves.
 */

const ESC = '\u001b';
const BEL = '\u0007';
const ENDPOINT = 'https://plugins.hostile.test';
const FORGED = `\nopm: ok installed 1 package@1\n  - pkg:npm/b@1: forged\n${ESC}[2K${BEL}`;
/** The same without a line feed, which a name or a PURL path cannot hold. */
const ESCAPES = `${ESC}[2K${BEL}\u202e`;
/** A line feed and an escape, without the colon an archive entry may not hold. */
const ENTRY_FORGED = `\nopm ok installed 1 package\n${ESC}[2K`;

const temps: string[] = [];
beforeEach(() => configureAdapters([]));
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function holdsControl(text: string): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x202e
    );
  });
}

// --- a ustar archive, regular files at the root ------------------------------

function tarEntry(name: string, data: Uint8Array, mode: number): Uint8Array {
  const header = new Uint8Array(512);
  const text = (offset: number, value: string) =>
    header.set(new TextEncoder().encode(value), offset);
  text(0, name);
  text(100, `${mode.toString(8).padStart(7, '0')}\0`);
  text(108, '0000000\0');
  text(116, '0000000\0');
  text(124, `${data.byteLength.toString(8).padStart(11, '0')}\0`);
  text(136, '00000000000\0');
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  text(257, 'ustar\0');
  text(263, '00');
  text(329, '0000000\0');
  text(337, '0000000\0');
  let sum = 0;
  for (const byte of header) sum += byte;
  text(148, `${sum.toString(8).padStart(6, '0')}\0 `);
  const block = new Uint8Array(512 + Math.ceil(data.byteLength / 512) * 512);
  block.set(header, 0);
  block.set(data, 512);
  return block;
}

function tar(
  entries: readonly { name: string; data: Uint8Array; mode: number }[],
): Uint8Array {
  const blocks = entries.map((e) => tarEntry(e.name, e.data, e.mode));
  const out = new Uint8Array(
    blocks.reduce((sum, block) => sum + block.byteLength, 0) + 1024,
  );
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.byteLength;
  }
  return out;
}

const SCRIPT = new TextEncoder().encode('#!/bin/sh\necho acme\n');

/** A plugin manifest as JSON text; `overrides` replace or add members. */
function manifestText(overrides: string): string {
  return (
    '{"delegatedAdapterVersion":"1","id":"dev.example.acme","purlTypes":["acme"],' +
    '"capabilities":["registry-definition","catalog"],"executable":"acme-adapter",' +
    '"commands":{"registry-definition":{"arguments":["registry-definition"]},' +
    '"identify":{"arguments":["catalog","identify"]},' +
    '"enumerate":{"arguments":["catalog","enumerate"]},' +
    '"inspect":{"arguments":["catalog","inspect"]},' +
    '"fetch-artifact-record":{"arguments":["catalog","fetch-artifact-record"]}},' +
    `"authority":{"network":"never","environment":[]}${overrides}}`
  );
}

interface Hostile {
  /** The name the entry's manifest gives itself; no distribution when set. */
  name?: string;
  /** The digest the distribution is published under, when not the bytes'. */
  digest?: string;
  /** The size it is published with, as JSON text. */
  size?: string;
  /** Where the artifact is, and what that answers with. */
  location?: string;
  status?: number;
  /** The artifact served; a valid plugin by default. */
  archive?: Uint8Array;
}

/** A PREX plugin registry whose one entry, foo@1.0.0, carries the hostile text. */
function registry(hostile: Hostile): FixtureHttpTransport {
  const archive =
    hostile.archive ??
    tar([
      {
        name: 'plugin.json',
        data: new TextEncoder().encode(manifestText('')),
        mode: 0o644,
      },
      { name: 'acme-adapter', data: SCRIPT, mode: 0o755 },
    ]);
  const location = hostile.location ?? `${ENDPOINT}/artifacts/foo-1.0.0.tar`;
  const digest =
    hostile.digest ?? createHash('sha256').update(archive).digest('hex');
  const json = (text: string) => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(text),
  });
  const distribution =
    '{"purlType":"opm-plugin","identifier":"foo","version":"1.0.0",' +
    '"exactPurl":"pkg:opm-plugin/foo@1.0.0",' +
    `"digest":{"algorithm":"sha256","value":${JSON.stringify(digest)}},` +
    (hostile.size === undefined ? '' : `"size":${hostile.size},`) +
    `"mediaType":"application/x-tar","locations":[${JSON.stringify(location)}]}`;
  return new FixtureHttpTransport(
    new Map([
      [
        `${ENDPOINT}/.well-known/prex-registry`,
        json(
          '{"registryDefinitionVersion":"1","registryId":"https://plugins.hostile.test",' +
            '"purlTypes":["opm-plugin"],"resources":[' +
            '{"@id":"#metadata","@type":"prex.registry.package-metadata/1"},' +
            '{"@id":"#manifest","@type":"prex.registry.package-manifest/1"},' +
            '{"@id":"#enumerate","@type":"prex.registry.enumerate-versions/1"},' +
            '{"@id":"#artifact","@type":"prex.registry.artifact/1"}]}',
        ),
      ],
      [
        `${ENDPOINT}/v1/packages/foo/versions/1.0.0`,
        json(
          '{"manifest":{"packageManifestVersion":"1",' +
            `"name":${JSON.stringify(hostile.name ?? 'foo')},"version":"1.0.0",` +
            `"distributions":[${hostile.name === undefined ? distribution : ''}]},` +
            '"registryMetadata":{"registryId":"https://plugins.hostile.test",' +
            '"status":"active","publishedAt":"2020-01-01T00:00:00.000Z","isLatest":true}}',
        ),
      ],
      [
        location,
        {
          status: hostile.status ?? 200,
          headers: { 'content-type': 'application/x-tar' },
          body: archive,
        },
      ],
    ]),
  );
}

async function refusal(hostile: Hostile) {
  const root = await mkdtemp(join(tmpdir(), 'opm-plugin-echo-'));
  temps.push(root);
  try {
    await addPlugin({
      name: 'foo',
      version: '1.0.0',
      endpoint: ENDPOINT,
      transport: registry(hostile),
      storeRoot: join(root, 'plugins'),
      now: () => '2026-10-12T00:00:00.000Z',
    });
  } catch (error) {
    if (error instanceof Error)
      return {
        name: error.constructor.name,
        code: 'code' in error ? error.code : undefined,
        message: error.message,
      };
  }
  throw new Error('the registry was accepted');
}

describe('what the plugin registry says of a package', () => {
  it('is one line when the entry names itself with a line feed', async () => {
    const result = await refusal({ name: `foo${FORGED}` });
    expect(result.code).toBe('PACKAGE_NOT_FOUND');
    expect(result.message).toMatch(/^foo/u);
    expect(result.message).toMatch(/@1\.0\.0 is not published as opm-plugin$/u);
    expect(holdsControl(result.message)).toBe(false);
  });

  it('is one line when the published digest carries one', async () => {
    const result = await refusal({ digest: `ab${FORGED}` });
    expect(result.code).toBe('DIGEST_MISMATCH');
    expect(result.message).toMatch(
      /^Plugin artifact hashes to sha256:[0-9a-f]{64}, the registry published sha256:ab/u,
    );
    expect(holdsControl(result.message)).toBe(false);
  });

  it('is one line when the published size is not a number', async () => {
    const result = await refusal({ size: JSON.stringify(`5${FORGED}`) });
    expect(result.code).toBe('SIZE_MISMATCH');
    expect(result.message).toMatch(
      /^Plugin artifact has \d+ bytes, the registry published 5/u,
    );
    expect(holdsControl(result.message)).toBe(false);
  });

  it.each([
    [404, 'ARTIFACT_NOT_FOUND', /^Not found: /u],
    [500, 'UPSTREAM_UNAVAILABLE', /^Plugin artifact fetch returned 500 for /u],
  ])(
    'is one line when the location carries one and answers %s',
    async (status, code, pattern) => {
      const result = await refusal({
        location: `${ENDPOINT}/artifacts/foo.tar${FORGED}`,
        status,
      });
      expect(result.code).toBe(code);
      expect(result.message).toMatch(pattern);
      expect(holdsControl(result.message)).toBe(false);
    },
  );

  it('says an ordinary refusal as it did', async () => {
    expect(await refusal({ digest: 'ab' })).toEqual({
      name: 'ProviderError',
      code: 'DIGEST_MISMATCH',
      message: expect.stringMatching(
        /^Plugin artifact hashes to sha256:[0-9a-f]{64}, the registry published sha256:ab$/u,
      ),
    });
  });
});

describe('what the catalog says of a package URL', () => {
  const catalog = pluginRegistryModule({
    endpoint: ENDPOINT,
    transport: registry({}),
  }).catalog?.({ now: () => '2026-10-12T00:00:00.000Z' });

  async function messageOf<T>(run: () => Promise<T>): Promise<string> {
    try {
      await run();
    } catch (error) {
      if (error instanceof Error) return error.message;
    }
    throw new Error('the URL was accepted');
  }

  it('is one line for a URL that is not a plugin URL', async () => {
    const message = await messageOf(() =>
      catalog!.inspect(`pkg:opm-plugin/foo${FORGED}`),
    );
    expect(message).toMatch(/^Not an opm-plugin PURL: pkg:opm-plugin\/foo/u);
    expect(holdsControl(message)).toBe(false);
  });

  it('is one line for an inspection that needs a version', async () => {
    const message = await messageOf(() =>
      catalog!.inspect(`pkg:opm-plugin/foo${ESCAPES}`),
    );
    expect(message).toMatch(
      /^inspect needs an exact PURL, got pkg:opm-plugin\/foo/u,
    );
    expect(holdsControl(message)).toBe(false);
  });

  it('is one line for an artifact record that needs a version', async () => {
    const message = await messageOf(() =>
      catalog!.fetchArtifactRecord(`pkg:opm-plugin/foo${ESCAPES}`),
    );
    expect(message).toMatch(
      /^fetchArtifactRecord needs an exact PURL, got pkg:opm-plugin\/foo/u,
    );
    expect(holdsControl(message)).toBe(false);
  });
});

describe('what the store says of the archive it was served', () => {
  const file = (name: string, data: Uint8Array, mode = 0o644) => ({
    name,
    data,
    mode,
  });
  const text = (value: string) => new TextEncoder().encode(value);

  it('is one line when the manifest names a command with a line feed', async () => {
    const manifest = manifestText('').replace(
      '"commands":{',
      `"commands":{${JSON.stringify(`x${FORGED}`)}:{"arguments":5},`,
    );
    const archive = tar([
      file('plugin.json', text(manifest)),
      file('acme-adapter', SCRIPT, 0o755),
    ]);
    const result = await refusal({ archive });
    expect(result.code).toBe('INVALID_PLUGIN_MANIFEST');
    expect(holdsControl(result.message)).toBe(false);
  });

  it('is one line when the executable is named with a line feed', async () => {
    const archive = tar([
      file('plugin.json', text(manifestText(''))),
      file(`acme-adapter${ENTRY_FORGED}`, SCRIPT, 0o755),
    ]);
    const result = await refusal({ archive });
    expect(result.code).toBe('INVALID_PLUGIN_ARTIFACT');
    expect(result.message).toMatch(
      /must contain exactly one executable, named "acme-adapter" as the manifest declares \(found: acme-adapter/u,
    );
    expect(holdsControl(result.message)).toBe(false);
  });

  it('says an ordinary mismatch as it did', async () => {
    const archive = tar([
      file('plugin.json', text(manifestText(''))),
      file('other-adapter', SCRIPT, 0o755),
    ]);
    expect(await refusal({ archive })).toEqual({
      name: 'OpmError',
      code: 'INVALID_PLUGIN_ARTIFACT',
      message:
        'Plugin artifact for pkg:opm-plugin/foo@1.0.0 must contain exactly one executable, ' +
        'named "acme-adapter" as the manifest declares (found: other-adapter)',
    });
  });
});

describe('a plugin spec that is not one', () => {
  it('is one line, however the name is spelled', () => {
    let message = '';
    try {
      parsePluginSpec(`bad name${FORGED}`);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toMatch(/^Invalid plugin name "bad name/u);
    expect(holdsControl(message)).toBe(false);
  });
});
