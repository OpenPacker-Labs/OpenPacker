import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadDelegatedPackProvider,
  parseDelegatedPackProvider,
} from './index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('delegated pack provider manifest', () => {
  it('loads a closed, typed provider manifest', async () => {
    const root = await temporaryRoot();
    const path = join(root, 'provider.json');
    await writeFile(path, JSON.stringify(provider()));

    await expect(loadDelegatedPackProvider(path)).resolves.toEqual(provider());
  });

  it('rejects unknown fields and template tokens', () => {
    expect(() =>
      parseDelegatedPackProvider({ ...provider(), surprise: true }),
    ).toThrow(/does not match/u);
    expect(() =>
      parseDelegatedPackProvider({
        ...provider(),
        commands: [{ arguments: ['{shell}'] }],
      }),
    ).toThrow(/does not match/u);
    expect(() =>
      parseDelegatedPackProvider({
        ...provider(),
        commands: [{ argv: ['sh', '-c', 'echo unsafe'] }],
      }),
    ).toThrow(/does not match/u);
  });

  it('uses the normative schema without parser drift', () => {
    expect(() =>
      parseDelegatedPackProvider({ ...provider(), displayName: '' }),
    ).not.toThrow();
    expect(() =>
      parseDelegatedPackProvider({
        ...provider(),
        purlTypes: ['a'.repeat(65)],
      }),
    ).toThrow(/does not match/u);
    expect(() =>
      parseDelegatedPackProvider({ ...provider(), $schema: 'not a uri' }),
    ).toThrow(/does not match/u);
  });

  it('does not follow a provider manifest symlink', async () => {
    const root = await temporaryRoot();
    const target = join(root, 'target.json');
    const link = join(root, 'provider.json');
    await writeFile(target, JSON.stringify(provider()));
    await symlink(target, link);

    await expect(loadDelegatedPackProvider(link)).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_MANIFEST',
    });
  });
});

function provider() {
  return {
    delegatedPackProviderVersion: '1' as const,
    id: 'example.test',
    purlTypes: ['test'],
    detection: { manifestNames: ['test.pack'] },
    executable: 'test-pack',
    commands: [
      {
        arguments: [
          'pack',
          { value: '--offline', when: 'offline' as const },
          '--out',
          '{outputDirectory}',
        ],
      },
    ],
    authority: {
      build: false,
      network: 'consent' as const,
      environment: ['TEST_TOKEN'],
    },
    artifacts: [
      {
        suffix: '.test',
        mediaType: 'application/x-test',
        nativeRole: 'distribution',
      },
    ],
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opm-pack-provider-manifest-'));
  roots.push(root);
  return root;
}
