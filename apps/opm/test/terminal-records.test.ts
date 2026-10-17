/**
 * The records opm prints from what a registry, a lock, a plugin store or a
 * project's manifests wrote, each written through `say`: one test per place
 * that prints one, with ESC, BEL, a C1 control and a right-to-left override in
 * the value (the review of #179, round 5, S2'). The places a test can reach
 * from the command line are driven through it; the rest through the printer
 * the command calls.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runOpm } from '../src/opm.js';
import {
  writeAdded,
  writeArtifactInfo,
  writeDocument,
  writeFacts,
  writeHostInstalled,
  writeHostPlan,
  writeImported,
  writeLosses,
  writePackArtifacts,
  writePackCommands,
  writePluginInstalled,
  writePluginList,
  writePluginRemoved,
  writePublished,
  writeUpdated,
  writeWarnings,
  writeYanked,
} from '../src/terminal-records.js';
import { capture } from './run-fixture.js';
import { unsafeIn } from './terminal-fixture.js';

/** An OSC title (ESC ... BEL), a CSI as its C1 control, and a right-to-left override. */
const HOSTILE = 'v\u001b]0;PWN\u0007\u009b2J\u202ex';
const SHOWN = 'v\\u001b]0;PWN\\u0007\\u009b2J\\u202ex';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opm-records-'));
  temps.push(dir);
  return dir;
}

/** What the terminal got, which holds the value escaped and nothing it acts on. */
function shown(c: ReturnType<typeof capture>): string {
  const all = c.out + c.err;
  expect(unsafeIn(all)).toEqual([]);
  expect(all).toContain(SHOWN);
  return all;
}

const DIGEST = `sha256:${'0'.repeat(64)}`;

/** A plugin store whose one pin carries `HOSTILE` in what the store keeps as text. */
async function hostilePluginStore(): Promise<string> {
  const home = await scratch();
  await writeFile(
    join(home, 'plugins.json'),
    `${JSON.stringify({
      pluginStoreVersion: 1,
      plugins: {
        acme: {
          id: `org.acme.${HOSTILE}`,
          name: 'acme',
          exactPurl: `pkg:opm-plugin/acme@1.0.0${HOSTILE}`,
          storeDigest: DIGEST,
          treeDigest: DIGEST,
          manifestPath: 'plugin.json',
          installedAt: '2026-10-17T00:00:00.000Z',
          format: 'tar',
        },
      },
    })}\n`,
  );
  return home;
}

async function withPluginHome<T>(
  home: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.env.OPM_PLUGIN_HOME;
  process.env.OPM_PLUGIN_HOME = home;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.OPM_PLUGIN_HOME;
    else process.env.OPM_PLUGIN_HOME = previous;
  }
}

describe('records opm prints, from the command line', () => {
  it('opm import --native: a range from package.json', async () => {
    const dir = await scratch();
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'app',
        version: '1.0.0',
        dependencies: { lodash: `^4.0.0 ${HOSTILE}` },
      }),
    );
    const c = capture();
    expect(await runOpm(['import', '--native', '--path', dir], c.io, dir)).toBe(
      0,
    );
    expect(shown(c)).toContain('lodash\tpkg:npm/lodash@^4.0.0 ');
  });

  it('opm plugin list: a pin the plugin store holds', async () => {
    const home = await hostilePluginStore();
    const c = capture();
    expect(
      await withPluginHome(home, () => runOpm(['plugin', 'list'], c.io, home)),
    ).toBe(0);
    expect(shown(c)).toContain('acme\tpkg:opm-plugin/acme@1.0.0');
  });

  it('opm plugin remove: the pin it removed', async () => {
    const home = await hostilePluginStore();
    const c = capture();
    expect(
      await withPluginHome(home, () =>
        runOpm(['plugin', 'remove', 'acme'], c.io, home),
      ),
    ).toBe(0);
    expect(shown(c)).toContain(
      'Removed plugin acme (pkg:opm-plugin/acme@1.0.0',
    );
  });
});

describe('records opm prints, through the printer the command calls', () => {
  const each = (write: (io: ReturnType<typeof capture>['io']) => void) => {
    const c = capture();
    write(c.io);
    return shown(c);
  };

  it('opm import --native: every field of a requirement', () => {
    each((io) =>
      writeImported(
        {
          manifestPath: '/p/opm.toml',
          imported: [
            {
              alias: HOSTILE,
              purl: `pkg:npm/${HOSTILE}`,
              range: HOSTILE,
              ecosystem: HOSTILE,
            },
          ],
        },
        io,
      ),
    );
  });

  it('opm add: the purl and install name the lock pinned', () => {
    each((io) => writeAdded('a', `pkg:npm/a@${HOSTILE}`, HOSTILE, io));
  });

  it('opm update: the requirements whose pins moved', () => {
    each((io) => writeUpdated([HOSTILE], io));
  });

  it('opm info: what the registry says of a package', () => {
    each((io) =>
      writeArtifactInfo(
        {
          exactPurl: `pkg:npm/a@${HOSTILE}`,
          version: HOSTILE,
          digest: HOSTILE,
          size: 1,
          mediaType: HOSTILE,
          uri: `https://registry.example/${HOSTILE}`,
        },
        io,
      ),
    );
  });

  it('opm manifest and opm pack: what the builder could not say', () => {
    each((io) => writeLosses([{ code: 'x', omittedMeaning: HOSTILE }], io));
  });

  it('opm manifest: the manifest printed whole', () => {
    each((io) => writeDocument(JSON.stringify({ name: HOSTILE }), io));
  });

  it('opm pack --dry-run: the native commands', () => {
    each((io) => writePackCommands('npm', [['npm', HOSTILE]], [[HOSTILE]], io));
  });

  it('opm pack: each archive produced', () => {
    each((io) =>
      writePackArtifacts(
        [{ path: HOSTILE, digest: DIGEST, size: 1, nativeRole: HOSTILE }],
        io,
      ),
    );
  });

  it('opm plugin add: the pin, its id and its store', () => {
    each((io) =>
      writePluginInstalled(
        {
          alreadyInstalled: false,
          name: 'acme',
          exactPurl: `pkg:opm-plugin/acme@${HOSTILE}`,
          id: HOSTILE,
          storeDigest: DIGEST,
          storePath: HOSTILE,
        },
        io,
      ),
    );
  });

  it('opm plugin remove and list: a pin', () => {
    each((io) => writePluginRemoved({ name: 'acme', exactPurl: HOSTILE }, io));
    each((io) =>
      writePluginList(
        [
          {
            name: 'acme',
            exactPurl: HOSTILE,
            storeDigest: DIGEST,
            installedAt: HOSTILE,
            present: false,
          },
        ],
        io,
      ),
    );
  });

  it('a host install: the native command, its losses and what it installed', () => {
    each((io) =>
      writeHostPlan(
        {
          command: ['apt-get', 'install', HOSTILE],
          semanticLoss: [{ code: 'x', representedMeaning: HOSTILE }],
          requiresElevation: true,
        },
        false,
        io,
      ),
    );
    each((io) =>
      writeHostInstalled({ exactPurl: HOSTILE, installedVersion: HOSTILE }, io),
    );
  });

  it('opm packslip verify: the warnings, the facts and the JSON', () => {
    each((io) => writeWarnings([{ code: 'x', message: HOSTILE }], io));
    each((io) =>
      writeFacts(`pkg:packslip/${HOSTILE}`, [['signer', HOSTILE]], io),
    );
    each((io) => writeDocument(JSON.stringify({ signer: HOSTILE }), io));
  });

  it('opm publish: the package and the registry', () => {
    each((io) => writePublished(HOSTILE, HOSTILE, HOSTILE, io));
  });

  it('opm yank: the version withdrawn', () => {
    each((io) => writeYanked(`pkg:npm/a@${HOSTILE}`, io));
  });
});
