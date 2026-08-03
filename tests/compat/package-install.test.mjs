import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const publicManifests = readdirSync(join(root, 'packages'))
  .map((name) =>
    JSON.parse(
      readFileSync(join(root, 'packages', name, 'package.json'), 'utf8'),
    ),
  )
  .filter((manifest) => manifest.private !== true);
const publicWorkspaces = publicManifests
  .map((manifest) => manifest.name)
  .sort();
const externalPackages = new Map();
const pending = publicManifests.flatMap((manifest) =>
  Object.keys(manifest.dependencies ?? {}).filter(
    (name) => !name.startsWith('@openpacker/'),
  ),
);
while (pending.length > 0) {
  const name = pending.pop();
  if (externalPackages.has(name)) continue;
  const directory = join(root, 'node_modules', name);
  const manifest = JSON.parse(
    readFileSync(join(directory, 'package.json'), 'utf8'),
  );
  externalPackages.set(name, directory);
  pending.push(...Object.keys(manifest.dependencies ?? {}));
}

function run(command, arguments_, cwd, environment = {}) {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_update_notifier: 'false',
      ...environment,
    },
  });
  assert.equal(
    result.status,
    0,
    `${command} ${arguments_.join(' ')} failed:\n${result.stderr || result.stdout}`,
  );
}

test('packed public packages install and run in a clean CommonJS TypeScript consumer', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'openpacker-sdk-consumer-'));
  const tarballs = join(fixture, 'tarballs');
  const npmEnvironment = { npm_config_cache: join(fixture, 'npm-cache') };
  mkdirSync(tarballs);
  try {
    for (const workspace of publicWorkspaces)
      run(
        npm,
        [
          'pack',
          '--silent',
          '--pack-destination',
          tarballs,
          '--workspace',
          workspace,
        ],
        root,
        npmEnvironment,
      );
    for (const directory of externalPackages.values())
      run(
        npm,
        ['pack', '--silent', '--pack-destination', tarballs, directory],
        root,
        npmEnvironment,
      );

    writeFileSync(
      join(fixture, 'package.json'),
      JSON.stringify({ name: 'openpacker-sdk-consumer', private: true }),
    );
    run(
      npm,
      [
        'install',
        '--ignore-scripts',
        '--offline',
        '--no-audit',
        '--no-fund',
        '--no-package-lock',
        ...readdirSync(tarballs).map((file) => join(tarballs, file)),
      ],
      fixture,
      npmEnvironment,
    );

    writeFileSync(
      join(fixture, 'consumer.cjs'),
      `for (const name of ${JSON.stringify(publicWorkspaces)}) require(name);\nconst { createOpenPackerClient } = require('@openpacker/sdk');\nif (typeof createOpenPackerClient !== 'function') process.exit(1);\n`,
    );
    writeFileSync(
      join(fixture, 'consumer.ts'),
      "import { createOpenPackerClient } from '@openpacker/sdk';\nconst client = createOpenPackerClient();\nvoid client;\n",
    );
    writeFileSync(
      join(fixture, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'CommonJS',
          moduleResolution: 'Node',
          noEmit: true,
          strict: true,
          target: 'ES2022',
        },
        files: ['consumer.ts'],
      }),
    );
    run(process.execPath, ['consumer.cjs'], fixture);
    run(
      npm,
      ['exec', '--', 'tsc', '-p', join(fixture, 'tsconfig.json')],
      root,
      npmEnvironment,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
