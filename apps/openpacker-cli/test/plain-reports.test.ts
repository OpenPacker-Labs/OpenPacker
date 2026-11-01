import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  CatalogProvider,
  InstallOutcome,
  InstallPlan,
  InstallerProvider,
  ProjectFormat,
} from '@openpacker/adapter-core';
import { moduleOf, type Parts } from './hostile-adapter.js';
import { HOSTILE, expectPlain, runWith } from './plain-fixture.js';

/**
 * What an adapter says in a report (the meaning a host install or a native
 * projection could not keep, a package the resolver could not place) and what a
 * project's directories are called cannot shape what opm writes: each value is
 * made one line where it is quoted, so that no line looks like opm's own after
 * any kind of line break, none holds a character a terminal acts on, and the
 * output has the lines it has for innocent text. The adapter is the program a
 * project binds (a plugin), driven through `runOpm`.
 */
/** The same text where a name must keep to what a file or a PURL can hold. */
const IN_A_NAME = HOSTILE.replace(/[@/?#]/gu, '');

type Loss = InstallPlan['semanticLoss'][number];

function loss(code: string, meaning: string): Loss {
  return {
    code,
    severity: 'warning',
    sourceEcosystem: 'acme',
    sourcePath: '/acme',
    originalMeaning: 'what was asked',
    representedMeaning: meaning,
    omittedMeaning: 'what was not kept',
    mitigation: 'none',
    blocksProfile: [],
  };
}

describe('opm add, for a host install an adapter performs', () => {
  type Where = 'command' | 'code' | 'meaning' | 'purl' | 'version';

  function installer(where: Where, text: string): InstallerProvider {
    const plan = (exactPurl: string): InstallPlan => ({
      exactPurl,
      command: ['acme-get', where === 'command' ? `demo${text}` : 'demo'],
      requiresElevation: false,
      irreversible: false,
      semanticLoss: [
        loss(
          where === 'code' ? `ACME_LOSS${text}` : 'ACME_LOSS',
          where === 'meaning' ? `kept${text}` : 'kept',
        ),
      ],
    });
    return {
      providerId: 'dev.test.host',
      capabilities: {
        operations: ['install'],
        purlTypes: ['acme'],
        qualifierSupport: 'none',
        targetSpecificSemantics: false,
        offlineReplay: false,
        extensions: {},
      },
      async available() {
        return { available: true };
      },
      async plan(exactPurl) {
        return plan(exactPurl);
      },
      async install(exactPurl): Promise<InstallOutcome> {
        return {
          ...plan(where === 'purl' ? `${exactPurl}${text}` : exactPurl),
          performed: true,
          exitCode: 0,
          stdout: '',
          stderr: '',
          installedVersion: where === 'version' ? `1.0.0${text}` : '1.0.0',
        };
      },
    };
  }

  const run = (where: Where) => (text: string) =>
    runWith({}, ['add', 'pkg:acme/demo@1.0.0'], {
      adapters: [moduleOf({ installer: installer(where, text) })],
    });

  it.each<[Where, string]>([
    ['command', 'acme-get demox\n'],
    ['code', 'opm: ACME_LOSSx: kept\n'],
    ['meaning', 'opm: ACME_LOSS: keptx\n'],
    ['purl', 'Host-installed pkg:acme/demo@1.0.0x @ 1.0.0\n'],
    ['version', 'Host-installed pkg:acme/demo@1.0.0 @ 1.0.0x\n'],
  ])('names what it did, on one line: %s', async (where, shown) => {
    const ran = await run(where)('x');
    expect(ran.code, ran.err).toBe(0);
    expect(ran.out + ran.err).toContain(shown);
    await expectPlain(run(where));
  });

  it('passes the installer’s own output through as it wrote it', async () => {
    // The one thing here that is not made plain, and on purpose: it is the
    // installer's output, not opm's, the way a script's is.
    const ran = await runWith({}, ['add', 'pkg:acme/demo@1.0.0'], {
      adapters: [
        moduleOf({
          installer: {
            ...installer('code', 'x'),
            async install(exactPurl) {
              return {
                ...(await installer('code', 'x').plan(exactPurl)),
                performed: true,
                exitCode: 0,
                stdout: 'progress\u001b[32m ok\u001b[0m\n',
                stderr: '',
              };
            },
          },
        }),
      ],
    });
    expect(ran.out).toContain('progress\u001b[32m ok\u001b[0m\n');
  });
});

describe('opm sync, for a native project file an adapter maintains', () => {
  type Where = 'path' | 'reason' | 'code' | 'meaning';

  function format(where: Where, text: string): ProjectFormat {
    return {
      providerId: 'dev.test.project',
      purlType: 'acme',
      async detect(root) {
        return { root, manifestPath: join(root, 'acme.json') };
      },
      async readRequirements() {
        return [];
      },
      async writeManifest(project) {
        return {
          written: [],
          skipped: [
            {
              path:
                where === 'path'
                  ? `${project.manifestPath}${text}`
                  : project.manifestPath,
              reason: where === 'reason' ? `left alone${text}` : 'left alone',
            },
          ],
          semanticLoss: [
            loss(
              where === 'code' ? `ACME_LOSS${text}` : 'ACME_LOSS',
              where === 'meaning' ? `kept${text}` : 'kept',
            ),
          ],
        };
      },
    };
  }

  const run = (where: Where) => (text: string) =>
    runWith(
      {
        'opm.toml': '[project]\nname = "p"\necosystems = ["acme"]\n',
        // An ecosystem the project already maintains is visited even when
        // nothing in the manifest or the lock names it.
        '.opm/native.json': JSON.stringify({
          nativeStateVersion: '1',
          managed: { acme: [] },
        }),
      },
      ['sync', '--offline'],
      { adapters: [moduleOf({ project: format(where, text) })] },
    );

  it.each<[Where, string]>([
    ['path', 'opm: skipped '],
    ['reason', 'left alonex\n'],
    ['code', 'opm: ACME_LOSSx: kept\n'],
    ['meaning', 'opm: ACME_LOSS: keptx\n'],
  ])('says what it left out on one line: %s', async (where, shown) => {
    const ran = await run(where)('x');
    expect(ran.code, ran.err).toBe(0);
    expect(ran.err).toContain(shown);
    await expectPlain(run(where), IN_A_NAME);
  });
});

describe('opm resolve, for a package the registry could not place', () => {
  type Where = 'purl' | 'reason';

  function catalog(where: Where, text: string): CatalogProvider {
    const candidate =
      where === 'purl' ? `pkg:acme/demo@1.0.0${text}` : 'pkg:acme/demo@1.0.0';
    return {
      providerId: 'dev.test.hostile',
      capabilities: {
        operations: ['enumerate', 'inspect'],
        purlTypes: ['acme'],
        qualifierSupport: 'none',
        targetSpecificSemantics: false,
        offlineReplay: false,
        extensions: {},
      },
      async identify() {
        return [];
      },
      async enumerate() {
        return [candidate];
      },
      async inspect() {
        throw new Error(where === 'reason' ? `no such release${text}` : 'gone');
      },
      async fetchArtifactRecord() {
        throw new Error('not in the fixture');
      },
      async snapshot() {
        throw new Error('not in the fixture');
      },
    };
  }

  const run = (where: Where) => (text: string) =>
    runWith({}, ['resolve', 'pkg:acme/demo'], {
      adapters: [moduleOf({ catalog: catalog(where, text) } as Parts)],
    });

  it.each<[Where, string]>([
    ['purl', 'opm: pkg:acme/demo@1.0.0x: gone\n'],
    ['reason', 'opm: pkg:acme/demo@1.0.0: no such releasex\n'],
  ])('names it and why on one line: %s', async (where, shown) => {
    const ran = await run(where)('x');
    expect(ran.err).toContain(shown);
    await expectPlain(run(where), IN_A_NAME);
  });
});

describe('opm system available, for an installer that says why it cannot', () => {
  type Where = 'reason' | 'tool';

  function installer(where: Where, text: string): InstallerProvider {
    return {
      providerId: 'dev.test.host',
      capabilities: {
        operations: ['install'],
        purlTypes: ['acme'],
        qualifierSupport: 'none',
        targetSpecificSemantics: false,
        offlineReplay: false,
        extensions: {},
      },
      async available() {
        return where === 'reason'
          ? { available: false, reason: `no acme-get${text}` }
          : {
              available: true,
              tool: { name: 'acme-get', version: `1.0${text}` },
            };
      },
      async plan() {
        throw new Error('not in the fixture');
      },
      async install() {
        throw new Error('not in the fixture');
      },
    };
  }

  const run = (where: Where) => (text: string) =>
    runWith({}, ['system', 'available'], {
      adapters: [moduleOf({ installer: installer(where, text) })],
    });

  it.each<[Where, string]>([
    ['reason', 'dev.test.hostile  acme  unavailable: no acme-getx\n'],
    ['tool', 'dev.test.hostile  acme  available (acme-get 1.0x)\n'],
  ])('lists it on one line: %s', async (where, shown) => {
    const ran = await run(where)('x');
    expect(ran.out, ran.err).toContain(shown);
    await expectPlain(run(where));
  });
});
