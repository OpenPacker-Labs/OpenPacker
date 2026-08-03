#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

export function rustMetadataToCycloneDx(metadata) {
  const packages = [...metadata.packages].sort((left, right) =>
    compare(left.id, right.id),
  );
  const references = new Map(
    packages.map((item) => [
      item.id,
      `pkg:cargo/${encodeURIComponent(item.name)}@${encodeURIComponent(item.version)}`,
    ]),
  );
  const components = packages.map((item) => ({
    type: 'library',
    'bom-ref': references.get(item.id),
    name: item.name,
    version: item.version,
    purl: references.get(item.id),
    ...(item.license ? { licenses: [{ expression: item.license }] } : {}),
    ...(item.source
      ? { externalReferences: [{ type: 'distribution', url: item.source }] }
      : {}),
  }));
  const dependencies = [...(metadata.resolve?.nodes ?? [])]
    .sort((left, right) => compare(left.id, right.id))
    .map((node) => ({
      ref: references.get(node.id),
      dependsOn: [...new Set(node.dependencies.map((id) => references.get(id)))]
        .filter(Boolean)
        .sort(),
    }));
  const identity = createHash('sha256')
    .update(JSON.stringify({ components, dependencies }))
    .digest('hex')
    .slice(0, 32)
    .split('');
  identity[12] = '5';
  identity[16] = ['8', '9', 'a', 'b'][Number.parseInt(identity[16], 16) % 4];
  const uuid = `${identity.slice(0, 8).join('')}-${identity.slice(8, 12).join('')}-${identity.slice(12, 16).join('')}-${identity.slice(16, 20).join('')}-${identity.slice(20).join('')}`;
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${uuid}`,
    version: 1,
    metadata: { component: { type: 'application', name: 'openpacker-rust' } },
    components,
    dependencies,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const metadata = JSON.parse(
    execFileSync(
      'cargo',
      ['metadata', '--locked', '--offline', '--format-version', '1'],
      { encoding: 'utf8' },
    ),
  );
  writeFileSync(
    process.argv[2] ?? 'openpacker-rust.cdx.json',
    `${JSON.stringify(rustMetadataToCycloneDx(metadata), null, 2)}\n`,
  );
}
