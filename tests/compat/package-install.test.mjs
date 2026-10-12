import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { copyWithoutScripts } from './pack-installed.mjs';

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

/**
 * Pack an installed dependency as the tarball its files make, without running
 * any lifecycle script it declares. `npm pack <directory>` runs the directory's
 * `prepare` even under `--ignore-scripts` (npm 10.9), and an installed package's
 * `prepare` is its author's build step, which needs their dev tools (`tshy` for
 * minimatch) and was never meant to run from `node_modules`. So the files are
 * packed from a copy whose manifest has no scripts (pack-installed.mjs), made
 * through any link so the installed manifest is never written.
 */
function packInstalled(directory, tarballs, scratch, index, environment) {
  const copy = join(scratch, String(index));
  copyWithoutScripts(directory, copy);
  run(
    npm,
    ['pack', '--silent', '--pack-destination', tarballs, copy],
    root,
    environment,
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
    const scratch = join(fixture, 'installed');
    mkdirSync(scratch);
    [...externalPackages.values()].forEach((directory, index) =>
      packInstalled(directory, tarballs, scratch, index, npmEnvironment),
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
