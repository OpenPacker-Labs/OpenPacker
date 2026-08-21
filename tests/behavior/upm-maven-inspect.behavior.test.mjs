/**
 * Behavior specifications for Maven stock-repository inspect. Given/When/Then
 * journeys over the public provider API: inspect of an exact PURL against
 * POM + checksum siblings, without an OpenPacker catalog.json sidecar.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const { FixtureHttpTransport } = await import('@openpacker/adapter-core');
const { MavenRepositoryProvider } = await import('@openpacker/adapter-maven');

const BASE = 'https://fixtures.openpacker.invalid/maven';
const POM_URL = `${BASE}/org/example/demo-tool/1.0.0/demo-tool-1.0.0.pom`;
const JAR_URL = `${BASE}/org/example/demo-tool/1.0.0/demo-tool-1.0.0.jar`;
const SHA256_URL = `${JAR_URL}.sha256`;
const CATALOG_URL = `${JAR_URL}.catalog.json`;
const JAR_SHA256 =
  'dc6627d2e2704fc93499bc6a144ff589bcf140c54ec4585d0407357a956beb8d';

const fixtures = join(root, 'fixtures/catalogs/maven');
const pom = await readFile(join(fixtures, 'demo-tool-1.0.0.pom'));
const sha256 = await readFile(join(fixtures, 'demo-tool-1.0.0.jar.sha256'));
const jar = await readFile(join(fixtures, 'demo-tool-1.0.0.jar'));

function ok(body) {
  return { status: 200, headers: {}, body };
}

test('Given a Maven layout fixture, when inspect is called with an exact PURL, then identity matches GAV and catalog.json is not required', async () => {
  // Given a stock Maven repository layout: POM, checksum sibling, jar bytes.
  // No *.catalog.json sidecar is published beside the artifact.
  const transport = new FixtureHttpTransport(
    new Map([
      [POM_URL, ok(pom)],
      [SHA256_URL, ok(sha256)],
      [JAR_URL, ok(jar)],
    ]),
  );
  const provider = new MavenRepositoryProvider(
    transport,
    { now: () => '2026-08-02T00:00:00Z' },
    BASE,
  );

  // When the user inspects the exact GAV PURL offline
  const inspection = await provider.inspect(
    'pkg:maven/org.example/demo-tool@1.0.0',
  );

  // Then identity is the POM GAV, digest comes from the sibling, and the
  // OpenPacker sidecar was never the metadata authority.
  assert.equal(
    inspection.package.identity.exactPurl,
    'pkg:maven/org.example/demo-tool@1.0.0',
  );
  assert.equal(inspection.package.identity.namespace, 'org.example');
  assert.equal(inspection.package.identity.name, 'demo-tool');
  assert.equal(
    inspection.package.nativeSemantics.data.openpackerSha256,
    JAR_SHA256,
  );
  const urls = transport.requests.map((request) => request.url);
  assert.ok(urls.includes(POM_URL), 'inspect must read the version POM');
  assert.ok(
    urls.includes(SHA256_URL),
    'inspect must read the sha256 checksum sibling',
  );
  assert.ok(
    urls.includes(POM_URL) && urls.includes(SHA256_URL),
    'POM and checksum siblings are the stock metadata authority',
  );
  void CATALOG_URL;
});
