import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configureAdapters } from '@openpacker/opm-project';
import { runOpm } from '../src/opm.js';
import { capture } from './capture.js';

/**
 * A plugin registry cannot add a line to what opm writes. `opm plugin add`
 * reads a PREX registry the operator names, and the plugin store makes the text
 * it repeats of that registry one line where it repeats it. Here a hostile
 * registry answers `opm plugin add foo@1.0.0` and the final stderr text is
 * counted.
 */

const ESC = '\u001b';
const BEL = '\u0007';
const ENDPOINT = 'https://plugins.hostile.test';
const FORGED = `\nopm: ok installed 1 package@1\n  - pkg:npm/b@1: forged\n${ESC}[2K${BEL}`;

const temps: string[] = [];
afterEach(async () => {
  configureAdapters([]);
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A JSON document: what a registry answers with. */
interface Document {
  [key: string]: Document | Document[] | string | boolean | number;
}

interface Hostile {
  /** The `name` of the registry entry's manifest. */
  name?: string;
  /** The sha256 the distribution is published under. */
  digest?: string;
}

/** A PREX plugin registry whose one entry, foo@1.0.0, carries `hostile` text. */
function registry(hostile: Hostile): typeof fetch {
  const json = (value: Document) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const location = `${ENDPOINT}/artifacts/foo-1.0.0.tar`;
  return async (input) => {
    const url = String(input);
    if (url.endsWith('/.well-known/prex-registry'))
      return json({
        registryDefinitionVersion: '1',
        registryId: ENDPOINT,
        purlTypes: ['opm-plugin'],
        resources: [
          { '@id': '#metadata', '@type': 'prex.registry.package-metadata/1' },
          { '@id': '#manifest', '@type': 'prex.registry.package-manifest/1' },
          {
            '@id': '#enumerate',
            '@type': 'prex.registry.enumerate-versions/1',
          },
          { '@id': '#artifact', '@type': 'prex.registry.artifact/1' },
        ],
      });
    if (url.endsWith('/v1/packages/foo/versions/1.0.0'))
      return json({
        manifest: {
          packageManifestVersion: '1',
          name: hostile.name ?? 'foo',
          version: '1.0.0',
          distributions:
            hostile.name === undefined
              ? [
                  {
                    purlType: 'opm-plugin',
                    identifier: 'foo',
                    version: '1.0.0',
                    exactPurl: 'pkg:opm-plugin/foo@1.0.0',
                    digest: {
                      algorithm: 'sha256',
                      value: hostile.digest ?? 'a'.repeat(64),
                    },
                    mediaType: 'application/x-tar',
                    locations: [location],
                  },
                ]
              : [],
        },
        registryMetadata: {
          registryId: ENDPOINT,
          status: 'active',
          publishedAt: '2020-01-01T00:00:00.000Z',
          isLatest: true,
        },
      });
    if (url === location) return new Response(new Uint8Array(1024));
    return new Response('not found', { status: 404 });
  };
}

/** The lines opm wrote to stderr for `opm plugin add foo@1.0.0`. */
async function stderrOf(hostile: Hostile): Promise<string[]> {
  const home = await mkdtemp(join(tmpdir(), 'opm-plugin-hostile-'));
  temps.push(home);
  const previous = [
    process.env.OPM_PLUGIN_HOME,
    process.env.OPM_REGISTRY_OPM_PLUGIN,
  ];
  process.env.OPM_PLUGIN_HOME = join(home, 'plugins');
  process.env.OPM_REGISTRY_OPM_PLUGIN = ENDPOINT;
  try {
    const cap = capture();
    await runOpm(['plugin', 'add', 'foo@1.0.0'], cap.io, home, {
      fetch: registry(hostile),
    });
    expect(cap.err).not.toContain(ESC);
    return cap.err.split('\n').slice(0, -1);
  } finally {
    for (const [index, name] of [
      'OPM_PLUGIN_HOME',
      'OPM_REGISTRY_OPM_PLUGIN',
    ].entries()) {
      const value = previous[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe('opm plugin add, against a hostile plugin registry', () => {
  it('writes one line when the entry names itself with a line feed', async () => {
    const lines = await stderrOf({ name: `foo${FORGED}` });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^opm: foo/u);
    expect(lines[0]).toContain('is not published as opm-plugin');
  });

  it('writes one line when the published digest carries one', async () => {
    const lines = await stderrOf({ digest: `ab${FORGED}` });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^opm: Plugin artifact hashes to sha256:[0-9a-f]{64}, the registry published sha256:ab/u,
    );
  });

  it('writes an ordinary refusal as it did', async () => {
    const lines = await stderrOf({ digest: 'ab' });
    expect(lines).toEqual([
      expect.stringMatching(
        /^opm: Plugin artifact hashes to sha256:[0-9a-f]{64}, the registry published sha256:ab$/u,
      ),
    ]);
  });
});
