#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const denied =
  /(?:^|[^A-Za-z])(?:AGPL|GPL|LGPL|SSPL)(?:-|[^A-Za-z]|$)|BUSL|Commons Clause/iu;
const licenseDenied = (license) =>
  license.split(/\s+OR\s+/iu).every((choice) => denied.test(choice));
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const npmPackages = [];

for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (!path.startsWith('node_modules/') || entry.link) continue;
  const manifestPath = join(root, path, 'package.json');
  if (!existsSync(manifestPath) && !entry.optional)
    throw new Error(`installed dependency manifest missing: ${path}`);
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : {
        name: path.slice('node_modules/'.length),
        version: entry.version,
        license: entry.license,
      };
  const license =
    typeof manifest.license === 'string'
      ? manifest.license
      : manifest.licenses?.map((item) => item.type ?? item).join(' OR ');
  if (!license)
    throw new Error(
      `${manifest.name}@${manifest.version} does not declare a license`,
    );
  if (licenseDenied(license))
    throw new Error(
      `${manifest.name}@${manifest.version} has denied license ${license}`,
    );
  npmPackages.push({ name: manifest.name, version: manifest.version, license });
}

function cargoMetadata(offline) {
  return spawnSync(
    'cargo',
    [
      'metadata',
      '--locked',
      ...(offline ? ['--offline'] : []),
      '--format-version',
      '1',
    ],
    { cwd: root, encoding: 'utf8' },
  );
}

// Prefer offline when the registry is already warm (local / post-fetch CI).
let cargo = cargoMetadata(true);
if (cargo.error) throw cargo.error;
if (cargo.status !== 0) {
  cargo = cargoMetadata(false);
  if (cargo.error) throw cargo.error;
  if (cargo.status !== 0)
    throw new Error(cargo.stderr || 'cargo metadata failed');
}
const workspace = JSON.parse(cargo.stdout);
const workspaceIds = new Set(workspace.workspace_members);
const cargoPackages = workspace.packages
  .filter(({ id }) => !workspaceIds.has(id))
  .map(({ name, version, license }) => {
    if (!license)
      throw new Error(`${name}@${version} does not declare a license`);
    if (licenseDenied(license))
      throw new Error(`${name}@${version} has denied license ${license}`);
    return { name, version, license };
  });

const report = {
  schemaVersion: 'org.openpacker.license-report.v1',
  npm: npmPackages.sort((a, b) =>
    compare(`${a.name}@${a.version}`, `${b.name}@${b.version}`),
  ),
  cargo: cargoPackages.sort((a, b) =>
    compare(`${a.name}@${a.version}`, `${b.name}@${b.version}`),
  ),
};
mkdirSync(join(root, '.demo-output'), { recursive: true });
writeFileSync(
  join(root, '.demo-output/license-report.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  `license scan: ${report.npm.length} npm + ${report.cargo.length} Cargo dependencies`,
);
