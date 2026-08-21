#!/usr/bin/env node
/**
 * Deterministic fuzz class for the Maven repository POM parser.
 *
 * Not wired into scripts/fuzz-smoke.mjs (that file is coordinator-owned for
 * this wave). Run with `node tests/fuzz/upm-maven-pom.mjs`.
 */
import assert from 'node:assert/strict';
import {
  interpolateMavenExpression,
  isMavenSnapshotVersion,
  parseMavenChecksum,
  parseMavenPom,
  pomHasImportBom,
  resolvedPomCoordinates,
  resolvedPomDependencies,
} from '@openpacker/adapter-maven';

const seed = '0x5eedmav1';
let state = Number(seed);
const random = () =>
  (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
const integer = (maximum) => Math.floor(random() * maximum);
const pick = (values) => values[integer(values.length)];
let cases = 0;
const count = (amount = 1) => {
  cases += amount;
};

const xmlEscape = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

const ident = () =>
  pick(['demo-tool', 'child-tool', 'commons-lang3', 'slf4j-api', 'guava']);
const group = () =>
  pick(['org.example', 'org.apache.commons', 'com.google.guava', 'org.slf4j']);
const version = () =>
  pick(['1.0.0', '1.2.3', '32.1.3-jre', '[3.12.0,4.0.0)', '1.0.0-SNAPSHOT']);

function pomDocument(input) {
  const properties = input.properties
    ? `<properties>${Object.entries(input.properties)
        .map(([name, value]) => `<${name}>${xmlEscape(value)}</${name}>`)
        .join('')}</properties>`
    : '';
  const parent = input.parent
    ? `<parent><groupId>${xmlEscape(input.parent.groupId)}</groupId><artifactId>${xmlEscape(input.parent.artifactId)}</artifactId><version>${xmlEscape(input.parent.version)}</version></parent>`
    : '';
  const bom = input.bom
    ? `<dependencyManagement><dependencies><dependency><groupId>${xmlEscape(input.bom.groupId)}</groupId><artifactId>${xmlEscape(input.bom.artifactId)}</artifactId><version>${xmlEscape(input.bom.version)}</version><type>pom</type><scope>import</scope></dependency></dependencies></dependencyManagement>`
    : '';
  const deps = (input.dependencies ?? [])
    .map((dependency) => {
      const exclusion = dependency.exclusion
        ? `<exclusions><exclusion><groupId>${xmlEscape(dependency.exclusion.groupId)}</groupId><artifactId>${xmlEscape(dependency.exclusion.artifactId)}</artifactId></exclusion></exclusions>`
        : '';
      return `<dependency><groupId>${xmlEscape(dependency.groupId)}</groupId><artifactId>${xmlEscape(dependency.artifactId)}</artifactId>${dependency.version === undefined ? '' : `<version>${xmlEscape(dependency.version)}</version>`}${dependency.scope === undefined ? '' : `<scope>${xmlEscape(dependency.scope)}</scope>`}${dependency.optional ? '<optional>true</optional>' : ''}${exclusion}</dependency>`;
    })
    .join('');
  const profile = input.profileDep
    ? `<profiles><profile><id>extra</id><dependencies><dependency><groupId>${xmlEscape(input.profileDep.groupId)}</groupId><artifactId>${xmlEscape(input.profileDep.artifactId)}</artifactId><version>${xmlEscape(input.profileDep.version)}</version></dependency></dependencies></profile></profiles>`
    : '';
  const gav = [
    input.groupId === undefined
      ? ''
      : `<groupId>${xmlEscape(input.groupId)}</groupId>`,
    input.artifactId === undefined
      ? ''
      : `<artifactId>${xmlEscape(input.artifactId)}</artifactId>`,
    input.version === undefined
      ? ''
      : `<version>${xmlEscape(input.version)}</version>`,
  ].join('');
  return `<?xml version="1.0"?><project>${parent}${gav}${properties}${bom}<dependencies>${deps}</dependencies>${profile}</project>`;
}

function assertNoLiteralProperty(dependencies) {
  for (const dependency of dependencies) {
    assert.doesNotMatch(dependency.groupId, /\$\{/u);
    assert.doesNotMatch(dependency.artifactId, /\$\{/u);
    if (dependency.version !== undefined)
      assert.doesNotMatch(dependency.version, /\$\{/u);
  }
}

for (let index = 0; index < 400; index += 1) {
  const groupId = group();
  const artifactId = ident();
  const ver = version();
  const propertyName = pick(['lib.version', 'revision', 'junit.version']);
  const xml = pomDocument({
    groupId,
    artifactId,
    version: ver.includes('SNAPSHOT') ? '1.0.0' : ver,
    properties: { [propertyName]: '9.9.9' },
    parent:
      integer(4) === 0
        ? { groupId: 'org.example', artifactId: 'parent-bom', version: '2.0.0' }
        : undefined,
    bom:
      integer(4) === 0
        ? {
            groupId: 'org.springframework.boot',
            artifactId: 'spring-boot-dependencies',
            version: '3.2.0',
          }
        : undefined,
    dependencies: [
      {
        groupId,
        artifactId: ident(),
        version: pick([ver, `\${${propertyName}}`, '${missing.property}']),
        scope: pick([undefined, 'compile', 'test', 'provided']),
        optional: integer(5) === 0,
        exclusion:
          integer(3) === 0
            ? { groupId: 'com.google.code.findbugs', artifactId: 'jsr305' }
            : undefined,
      },
      {
        groupId: 'org.example',
        artifactId: 'managed',
      },
    ],
    profileDep:
      integer(3) === 0
        ? {
            groupId: 'org.example',
            artifactId: 'profile-only',
            version: '9.9.9',
          }
        : undefined,
  });
  const pom = parseMavenPom(xml);
  const coordinates = resolvedPomCoordinates(pom);
  assert.equal(coordinates.complete, true);
  assert.equal(coordinates.groupId, groupId);
  assert.equal(coordinates.artifactId, artifactId);
  const { included, skippedUnresolved } = resolvedPomDependencies(pom);
  assertNoLiteralProperty(included);
  assert.ok(skippedUnresolved.length >= 1);
  if (pom.parent) assert.ok(pom.parent.artifactId === 'parent-bom');
  if (pomHasImportBom(pom))
    assert.ok(pom.dependencyManagement.some((dep) => dep.scope === 'import'));
  count(3);
}

for (let index = 0; index < 200; index += 1) {
  const xml = pomDocument({
    parent: {
      groupId: 'org.example',
      artifactId: 'parent-bom',
      version: '2.0.0',
    },
    artifactId: ident(),
    dependencies: [{ groupId: group(), artifactId: ident(), version: '1.0.0' }],
  });
  const pom = parseMavenPom(xml);
  assert.equal(resolvedPomCoordinates(pom).complete, false);
  count();
}

for (let index = 0; index < 200; index += 1) {
  const payload = pick([
    '',
    '<not-a-pom/>',
    '<project>',
    '<project><groupId>',
    randomBytesXml(),
  ]);
  try {
    const pom = parseMavenPom(payload);
    const coordinates = resolvedPomCoordinates(pom);
    assert.equal(typeof coordinates.complete, 'boolean');
    if (coordinates.complete) {
      assert.ok(coordinates.groupId);
      assert.ok(coordinates.artifactId);
      assert.ok(coordinates.version);
      assert.doesNotMatch(coordinates.groupId, /\$\{/u);
    }
  } catch (error) {
    assert.equal(error.code, 'INVALID_PROVIDER_METADATA');
  }
  count();
}

for (let index = 0; index < 100; index += 1) {
  const hex = [...Array(64)].map(() => pick('0123456789abcdefABCDEF')).join('');
  assert.equal(
    parseMavenChecksum(`${hex}  artifact.jar\n`, 64),
    hex.toLowerCase(),
  );
  assert.equal(parseMavenChecksum('not-hex', 64), undefined);
  assert.equal(
    interpolateMavenExpression('${a}', { a: '1.0.0' }).value,
    '1.0.0',
  );
  assert.equal(interpolateMavenExpression('${missing}', {}).unresolved, true);
  assert.equal(isMavenSnapshotVersion('1.0.0-SNAPSHOT'), true);
  assert.equal(isMavenSnapshotVersion('1.0.0'), false);
  count(4);
}

function randomBytesXml() {
  const length = integer(64);
  let body = '<project>';
  for (let index = 0; index < length; index += 1)
    body += pick(['<', '>', '/', 'x', ' ', '1', '${', '}']);
  return body;
}

assert.ok(cases >= 1_700, `expected a dense POM fuzz class, got ${cases}`);
console.log(`ok  upm-maven-pom fuzz class cases=${cases}`);
