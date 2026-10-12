/**
 * Stock Maven repository POM reader for inspect.
 *
 * Parses one POM file in isolation. Parent POMs and imported BOMs are never
 * fetched; callers record that as semantic loss instead of pretending the
 * effective model is complete.
 */

import { XMLParser } from 'fast-xml-parser';
import { echoed, ProviderError } from '@openpacker/adapter-core';

export interface MavenDependency {
  groupId: string;
  artifactId: string;
  version?: string;
  type?: string;
  classifier?: string;
  scope?: string;
  optional?: boolean;
  exclusions?: readonly { groupId: string; artifactId: string }[];
}

export interface MavenPomParent {
  groupId?: string;
  artifactId?: string;
  version?: string;
}

export interface MavenPomDocument {
  groupId?: string;
  artifactId?: string;
  version?: string;
  packaging?: string;
  name?: string;
  description?: string;
  parent?: MavenPomParent;
  properties: Readonly<Record<string, string>>;
  dependencies: readonly MavenDependency[];
  dependencyManagement: readonly MavenDependency[];
  profileDependencies: readonly MavenDependency[];
}

export interface ResolvedPomCoordinates {
  groupId?: string;
  artifactId?: string;
  version?: string;
  packaging: string;
  complete: boolean;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
  isArray: (name) =>
    name === 'dependency' || name === 'exclusion' || name === 'profile',
});

const PROPERTY = /\$\{([^}]+)\}/gu;

export function parseMavenPom(xml: string): MavenPomDocument {
  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch (error) {
    throw new ProviderError(
      'INVALID_PROVIDER_METADATA',
      error instanceof Error
        ? echoed(error.message)
        : 'POM XML could not be parsed',
    );
  }
  const project = record(parsed)?.project;
  const root = record(project);
  if (root === undefined)
    throw new ProviderError(
      'INVALID_PROVIDER_METADATA',
      'POM is missing a project document element',
    );

  const groupId = xmlText(root.groupId);
  const artifactId = xmlText(root.artifactId);
  const version = xmlText(root.version);
  const packaging = xmlText(root.packaging);
  const name = xmlText(root.name);
  const description = xmlText(root.description);
  const parent = readParent(root.parent);
  return {
    ...(!(groupId === undefined) && { groupId }),
    ...(!(artifactId === undefined) && { artifactId }),
    ...(!(version === undefined) && { version }),
    ...(!(packaging === undefined) && { packaging }),
    ...(!(name === undefined) && { name }),
    ...(!(description === undefined) && { description }),
    ...(!(parent === undefined) && { parent }),
    properties: readProperties(root.properties),
    dependencies: readDependencies(record(root.dependencies)),
    dependencyManagement: readDependencies(
      record(record(root.dependencyManagement)?.dependencies),
    ),
    profileDependencies: readProfileDependencies(root.profiles),
  };
}

export function interpolateMavenExpression(
  value: string,
  properties: Readonly<Record<string, string>>,
) {
  let current = value;
  for (let depth = 0; depth < 16; depth += 1) {
    if (!current.includes('${')) return { value: current, unresolved: false };
    let missing = false;
    const next = current.replace(PROPERTY, (match, name: string) => {
      const replacement = properties[name.trim()];
      if (replacement === undefined) {
        missing = true;
        return match;
      }
      return replacement;
    });
    if (missing) return { value: next, unresolved: true };
    if (next === current)
      return { value: next, unresolved: next.includes('${') };
    current = next;
  }
  return { value: current, unresolved: true };
}

export function resolvedPomCoordinates(
  pom: MavenPomDocument,
): ResolvedPomCoordinates {
  const properties = interpolationProperties(pom);
  const groupId = resolveToken(pom.groupId, properties);
  const artifactId = resolveToken(pom.artifactId, properties);
  const version = resolveToken(pom.version, properties);
  const packaging = resolveToken(pom.packaging, properties) ?? 'jar';
  return {
    ...(!(groupId === undefined) && { groupId }),
    ...(!(artifactId === undefined) && { artifactId }),
    ...(!(version === undefined) && { version }),
    packaging,
    complete:
      groupId !== undefined &&
      artifactId !== undefined &&
      version !== undefined,
  };
}

export function resolvedPomDependencies(pom: MavenPomDocument) {
  const coordinates = resolvedPomCoordinates(pom);
  const properties = {
    ...pom.properties,
    ...projectPropertyKeys(
      coordinates.groupId,
      coordinates.artifactId,
      coordinates.version,
      coordinates.packaging,
    ),
  };
  const included: MavenDependency[] = [];
  const skippedUnresolved: MavenDependency[] = [];
  for (const dependency of pom.dependencies) {
    const resolved = resolveDependency(dependency, properties);
    if (resolved === undefined) skippedUnresolved.push(dependency);
    else included.push(resolved);
  }
  return { included, skippedUnresolved };
}

export function pomHasImportBom(pom: MavenPomDocument): boolean {
  return (
    pom.dependencies.some(isImportBom) ||
    pom.dependencyManagement.some(isImportBom)
  );
}

export function isMavenSnapshotVersion(version: string): boolean {
  return /(?:^|[.-])SNAPSHOT$/iu.test(version.trim());
}

function isImportBom(dependency: MavenDependency): boolean {
  return (dependency.scope ?? '').toLowerCase() === 'import';
}

function interpolationProperties(pom: MavenPomDocument) {
  return {
    ...pom.properties,
    ...projectPropertyKeys(
      pom.groupId,
      pom.artifactId,
      pom.version,
      pom.packaging,
    ),
  };
}

function projectPropertyKeys(
  groupId: string | undefined,
  artifactId: string | undefined,
  version: string | undefined,
  packaging: string | undefined,
) {
  const properties: Record<string, string> = {};
  assignAliases(
    properties,
    ['project.groupId', 'pom.groupId', 'groupId'],
    groupId,
  );
  assignAliases(
    properties,
    ['project.artifactId', 'pom.artifactId', 'artifactId'],
    artifactId,
  );
  assignAliases(
    properties,
    ['project.version', 'pom.version', 'version'],
    version,
  );
  assignAliases(
    properties,
    ['project.packaging', 'packaging'],
    packaging ?? 'jar',
  );
  return properties;
}

function assignAliases(
  target: Record<string, string>,
  keys: readonly string[],
  value: string | undefined,
): void {
  if (value === undefined) return;
  for (const key of keys) target[key] = value;
}

function resolveToken(
  raw: string | undefined,
  properties: Readonly<Record<string, string>>,
): string | undefined {
  if (raw === undefined) return undefined;
  const { value, unresolved } = interpolateMavenExpression(raw, properties);
  if (unresolved || value.length === 0) return undefined;
  return value;
}

function resolveDependency(
  dependency: MavenDependency,
  properties: Readonly<Record<string, string>>,
): MavenDependency | undefined {
  const groupId = resolveToken(dependency.groupId, properties);
  const artifactId = resolveToken(dependency.artifactId, properties);
  const version = resolveToken(dependency.version, properties);
  if (
    groupId === undefined ||
    artifactId === undefined ||
    version === undefined
  )
    return undefined;
  const type = resolveToken(dependency.type, properties);
  const classifier = resolveToken(dependency.classifier, properties);
  if (dependency.type !== undefined && type === undefined) return undefined;
  if (dependency.classifier !== undefined && classifier === undefined)
    return undefined;
  const exclusions = resolveExclusions(dependency.exclusions, properties);
  return {
    groupId,
    artifactId,
    version,
    ...(!(type === undefined) && { type }),
    ...(!(classifier === undefined) && { classifier }),
    ...(!(dependency.scope === undefined) && { scope: dependency.scope }),
    ...(!(dependency.optional === undefined) && {
      optional: dependency.optional,
    }),
    ...(!(exclusions === undefined) && { exclusions }),
  };
}

function resolveExclusions(
  exclusions: MavenDependency['exclusions'],
  properties: Readonly<Record<string, string>>,
): MavenDependency['exclusions'] | undefined {
  if (exclusions === undefined) return undefined;
  const resolved: { groupId: string; artifactId: string }[] = [];
  for (const exclusion of exclusions) {
    const groupId = resolveToken(exclusion.groupId, properties);
    const artifactId = resolveToken(exclusion.artifactId, properties);
    if (groupId === undefined || artifactId === undefined) continue;
    resolved.push({ groupId, artifactId });
  }
  return resolved;
}

function readParent(value: unknown): MavenPomParent | undefined {
  const node = record(value);
  if (node === undefined) return undefined;
  const groupId = xmlText(node.groupId);
  const artifactId = xmlText(node.artifactId);
  const version = xmlText(node.version);
  if (
    groupId === undefined &&
    artifactId === undefined &&
    version === undefined
  )
    return undefined;
  return {
    ...(!(groupId === undefined) && { groupId }),
    ...(!(artifactId === undefined) && { artifactId }),
    ...(!(version === undefined) && { version }),
  };
}

function readProperties(value: unknown) {
  const node = record(value);
  if (node === undefined) return {};
  const properties: Record<string, string> = {};
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith('@_')) continue;
    const text = xmlText(child);
    if (text !== undefined) properties[key] = text;
  }
  return properties;
}

function readProfileDependencies(value: unknown): MavenDependency[] {
  const profiles = record(value)?.profile;
  const out: MavenDependency[] = [];
  for (const profile of asList(profiles)) {
    out.push(...readDependencies(record(record(profile)?.dependencies)));
  }
  return out;
}

function readDependencies(
  node: Record<string, unknown> | undefined,
): MavenDependency[] {
  if (node === undefined) return [];
  const out: MavenDependency[] = [];
  for (const dependency of asList(node.dependency)) {
    const parsed = readDependency(dependency);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

function readDependency(value: unknown): MavenDependency | undefined {
  const node = record(value);
  if (node === undefined) return undefined;
  const groupId = xmlText(node.groupId);
  const artifactId = xmlText(node.artifactId);
  if (groupId === undefined || artifactId === undefined) return undefined;
  const version = xmlText(node.version);
  const type = xmlText(node.type);
  const classifier = xmlText(node.classifier);
  const scope = xmlText(node.scope);
  const optionalText = xmlText(node.optional);
  const optional =
    optionalText === undefined
      ? undefined
      : optionalText.toLowerCase() === 'true';
  const exclusions = readExclusions(node.exclusions);
  return {
    groupId,
    artifactId,
    ...(!(version === undefined) && { version }),
    ...(!(type === undefined) && { type }),
    ...(!(classifier === undefined) && { classifier }),
    ...(!(scope === undefined) && { scope }),
    ...(!(optional === undefined) && { optional }),
    ...(!(exclusions === undefined) && { exclusions }),
  };
}

function readExclusions(
  value: unknown,
): { groupId: string; artifactId: string }[] | undefined {
  const node = record(value);
  if (node === undefined) return undefined;
  const exclusions: { groupId: string; artifactId: string }[] = [];
  for (const exclusion of asList(node.exclusion)) {
    const child = record(exclusion);
    const groupId = xmlText(child?.groupId);
    const artifactId = xmlText(child?.artifactId);
    if (groupId === undefined || artifactId === undefined) continue;
    exclusions.push({ groupId, artifactId });
  }
  return exclusions;
}

function xmlText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  const node = record(value);
  if (node === undefined) return undefined;
  return xmlText(node['#text']);
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined;
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  return value as Record<string, unknown>;
}

function asList(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}
