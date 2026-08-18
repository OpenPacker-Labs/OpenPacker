import { createHash } from 'node:crypto';
import type { NormalizedPackInput } from '@openpacker/adapter-core';
import { ProviderError } from '@openpacker/adapter-core';
import { canonicalBytes } from '@openpacker/canonical';
import type { JsonValue } from '@openpacker/contracts';
import { packTar, packTarGzip, packZip } from '@openpacker/project-io';
import { parse as parseYaml } from 'yaml';

export interface StandardEmitterArtifact {
  fileName: string;
  bytes: Uint8Array;
  mediaType: string;
  nativeRole: string;
  exactPurl?: string;
}

export interface StandardEmitter {
  expectedRoles: readonly string[];
  emit(input: NormalizedPackInput): Promise<readonly StandardEmitterArtifact[]>;
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

export const standardEmitters = {
  npm: emitter(['distribution'], async (input) => [
    artifact(
      `${fileStem(input)}.tgz`,
      packTarGzip(
        input.files.map((file) => ({ ...file, path: `package/${file.path}` })),
      ),
      'application/vnd.npm.package+gzip',
      'distribution',
      input,
    ),
  ]),
  cargo: emitter(['distribution'], async (input) => {
    const prefix = `${safe(input.manifest.target.identifier)}-${safe(
      input.manifest.target.version,
    )}`;
    return [
      artifact(
        `${prefix}.crate`,
        packTarGzip(
          input.files.map((file) => ({
            ...file,
            path: `${prefix}/${file.path}`,
          })),
        ),
        'application/gzip',
        'distribution',
        input,
      ),
    ];
  }),
  pypi: emitter(['source-distribution'], async (input) => {
    const prefix = `${pythonName(input.manifest.target.identifier)}-${safe(
      input.manifest.target.version,
    )}`;
    const metadata = text(
      [
        'Metadata-Version: 2.1',
        `Name: ${input.manifest.target.identifier}`,
        `Version: ${input.manifest.target.version}`,
        ...(input.manifest.package.description === undefined
          ? []
          : [`Summary: ${input.manifest.package.description}`]),
        ...input.manifest.requirements.map(
          (requirement) =>
            `Requires-Dist: ${requirement.identifier}${requirement.range ?? ''}`,
        ),
        '',
      ].join('\n'),
    );
    return [
      artifact(
        `${prefix}.tar.gz`,
        packTarGzip([
          ...input.files.map((file) => ({
            ...file,
            path: `${prefix}/${file.path}`,
          })),
          ...(input.files.some((file) => file.path === 'PKG-INFO')
            ? []
            : [{ path: `${prefix}/PKG-INFO`, contents: metadata }]),
        ]),
        'application/gzip',
        'source-distribution',
        input,
      ),
    ];
  }),
  nuget: emitter(['distribution'], async (input) => {
    const target = input.manifest.target;
    const nuspec = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">',
      '  <metadata>',
      `    <id>${xml(target.identifier)}</id>`,
      `    <version>${xml(target.version)}</version>`,
      `    <authors>${xml(input.manifest.package.name)}</authors>`,
      `    <description>${xml(input.manifest.package.description ?? input.manifest.package.name)}</description>`,
      '    <dependencies>',
      ...input.manifest.requirements.map(
        (requirement) =>
          `      <dependency id="${xml(requirement.identifier)}" version="${xml(requirement.range ?? '0.0.0')}" />`,
      ),
      '    </dependencies>',
      '  </metadata>',
      '</package>',
      '',
    ].join('\n');
    const entries = [
      { path: `${target.identifier}.nuspec`, contents: text(nuspec) },
      {
        path: '[Content_Types].xml',
        contents: text(
          '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="nuspec" ContentType="application/octet"/></Types>',
        ),
      },
      ...input.files.map((file) => ({
        ...file,
        path: `content/${file.path}`,
      })),
    ];
    return [
      artifact(
        `${safe(target.identifier)}.${safe(target.version)}.nupkg`,
        packZip(entries),
        'application/vnd.nuget.package',
        'distribution',
        input,
      ),
    ];
  }),
  maven: emitter(['distribution'], async (input) => {
    const [, artifactId = input.manifest.target.identifier] =
      input.manifest.target.identifier.split(':', 2);
    const manifest = text(
      'Manifest-Version: 1.0\r\nCreated-By: OpenPacker\r\n\r\n',
    );
    return [
      artifact(
        `${safe(artifactId)}-${safe(input.manifest.target.version)}.jar`,
        packZip([
          { path: 'META-INF/MANIFEST.MF', contents: manifest },
          ...input.files,
        ]),
        'application/java-archive',
        'distribution',
        input,
      ),
    ];
  }),
  oci: emitter(['oci-layout'], async (input) => [emitOci(input)]),
  nix: emitter(['nar'], async (input) => [
    artifact(
      `${fileStem(input)}.nar`,
      packNar(input.files),
      'application/x-nix-archive',
      'nar',
      input,
    ),
  ]),
  deb: emitter(['distribution'], async (input) => [emitDeb(input)]),
  winget: emitter(['manifest'], async (input) => {
    const files = input.files.filter((file) => /\.ya?ml$/iu.test(file.path));
    validateWingetManifestSet(input, files);
    return files.map((file) =>
      artifact(
        file.path.split('/').at(-1)!,
        file.contents,
        'application/yaml',
        'manifest',
        input,
      ),
    );
  }),
  chocolatey: emitter(['distribution'], async (input) => [
    artifact(
      `${fileStem(input)}.nupkg`,
      packZip(input.files),
      'application/zip',
      'distribution',
      input,
    ),
  ]),
  golang: emitter(
    ['module-zip', 'module-file', 'version-info'],
    async (input) => {
      const target = input.manifest.target;
      const module = target.identifier;
      const version = target.version.startsWith('v')
        ? target.version
        : `v${target.version}`;
      const goMod = input.files.find((file) => file.path === 'go.mod');
      if (goMod === undefined)
        throw new ProviderError(
          'INVALID_REQUEST',
          'Go standard packing requires go.mod',
        );
      return [
        artifact(
          `${safe(module)}-${safe(version)}.zip`,
          packZip(
            input.files.map((file) => ({
              ...file,
              path: `${module}@${version}/${file.path}`,
            })),
          ),
          'application/zip',
          'module-zip',
          input,
        ),
        artifact(
          `${safe(module)}-${safe(version)}.mod`,
          goMod.contents,
          'text/plain',
          'module-file',
          input,
        ),
        artifact(
          `${safe(module)}-${safe(version)}.info`,
          canonicalBytes({
            Version: version,
            Time: '1970-01-01T00:00:00Z',
          } as unknown as JsonValue),
          'application/json',
          'version-info',
          input,
        ),
      ];
    },
  ),
} as const;

function validateWingetManifestSet(
  input: NormalizedPackInput,
  files: NormalizedPackInput['files'],
): void {
  const types = new Set<string>();
  for (const file of files) {
    let value: unknown;
    try {
      value = parseYaml(new TextDecoder().decode(file.contents), {
        maxAliasCount: 0,
      });
    } catch (error) {
      invalidWinget(`${file.path} is not valid YAML: ${errorMessage(error)}`);
    }
    if (!isRecord(value)) invalidWinget(`${file.path} must contain a mapping`);
    const required = [
      'PackageIdentifier',
      'PackageVersion',
      'ManifestType',
      'ManifestVersion',
    ];
    for (const field of required)
      if (typeof value[field] !== 'string' || value[field].trim() === '')
        invalidWinget(`${file.path} requires ${field}`);
    if (value.PackageIdentifier !== input.manifest.target.identifier)
      invalidWinget(`${file.path} PackageIdentifier does not match the target`);
    if (value.PackageVersion !== input.manifest.target.version)
      invalidWinget(`${file.path} PackageVersion does not match the target`);
    const type = value.ManifestType as string;
    if (
      ![
        'singleton',
        'version',
        'installer',
        'defaultLocale',
        'locale',
      ].includes(type)
    )
      invalidWinget(`${file.path} has unsupported ManifestType ${type}`);
    if (types.has(type) && type !== 'locale')
      invalidWinget(`WinGet manifest set contains duplicate ${type} manifests`);
    types.add(type);
    if (!/^\d+\.\d+\.\d+$/u.test(value.ManifestVersion as string))
      invalidWinget(`${file.path} has an invalid ManifestVersion`);
    if (type === 'installer' || type === 'singleton')
      validateWingetInstallers(
        file.path,
        value.Installers,
        value.InstallerType,
      );
    if (type === 'version' && !nonEmpty(value.DefaultLocale))
      invalidWinget(`${file.path} requires DefaultLocale`);
    if (
      (type === 'defaultLocale' || type === 'singleton') &&
      ![
        'PackageLocale',
        'Publisher',
        'PackageName',
        'License',
        'ShortDescription',
      ].every((field) => nonEmpty(value[field]))
    )
      invalidWinget(`${file.path} is missing required locale metadata`);
    if (type === 'locale' && !nonEmpty(value.PackageLocale))
      invalidWinget(`${file.path} requires PackageLocale`);
  }
  const singleton = types.has('singleton');
  if (
    files.length === 0 ||
    (singleton
      ? files.length !== 1
      : !['version', 'installer', 'defaultLocale'].every((type) =>
          types.has(type),
        ))
  )
    invalidWinget(
      'WinGet requires one singleton manifest or a version, installer, and defaultLocale set',
    );
}

function validateWingetInstallers(
  path: string,
  value: unknown,
  defaultInstallerType: unknown,
): void {
  if (!Array.isArray(value) || value.length === 0)
    invalidWinget(`${path} requires at least one installer`);
  for (const installer of value) {
    if (
      !isRecord(installer) ||
      !['x86', 'x64', 'arm', 'arm64', 'neutral'].includes(
        String(installer.Architecture),
      ) ||
      (!nonEmpty(defaultInstallerType) && !nonEmpty(installer.InstallerType)) ||
      !nonEmpty(installer.InstallerUrl) ||
      typeof installer.InstallerSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/iu.test(installer.InstallerSha256)
    )
      invalidWinget(`${path} contains an incomplete installer`);
    try {
      const url = new URL(installer.InstallerUrl as string);
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error();
    } catch {
      invalidWinget(`${path} contains an invalid InstallerUrl`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function invalidWinget(message: string): never {
  throw new ProviderError('INVALID_REQUEST', message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emitter(
  expectedRoles: readonly string[],
  emit: StandardEmitter['emit'],
): StandardEmitter {
  return { expectedRoles, emit };
}

function artifact(
  fileName: string,
  bytes: Uint8Array,
  mediaType: string,
  nativeRole: string,
  input: NormalizedPackInput,
): StandardEmitterArtifact {
  return {
    fileName,
    bytes,
    mediaType,
    nativeRole,
    ...(input.manifest.target.exactPurl === undefined
      ? {}
      : { exactPurl: input.manifest.target.exactPurl }),
  };
}

function fileStem(input: NormalizedPackInput): string {
  return `${safe(input.manifest.target.identifier)}-${safe(
    input.manifest.target.version,
  )}`;
}

function safe(value: string): string {
  const safeValue = value
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  if (safeValue === '')
    throw new ProviderError('INVALID_REQUEST', `Unsafe package name: ${value}`);
  return safeValue;
}

function pythonName(value: string): string {
  return safe(value).replace(/[-.]+/gu, '_');
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function emitOci(input: NormalizedPackInput): StandardEmitterArtifact {
  const metadata = input.manifest.nativeMetadata;
  const os = metadata['dev.openpacker.oci.os'];
  const architecture = metadata['dev.openpacker.oci.architecture'];
  if (typeof os !== 'string' || typeof architecture !== 'string')
    throw new ProviderError(
      'INVALID_REQUEST',
      'OCI standard packing requires explicit dev.openpacker.oci.os and dev.openpacker.oci.architecture target metadata',
    );
  const layer = packTar(input.files);
  const layerDigest = digest(layer);
  const config = canonicalBytes({
    architecture,
    os,
    config: {
      Entrypoint: input.manifest.oci.config.entrypoint,
      Cmd: input.manifest.oci.config.arguments,
      Env: Object.entries(input.manifest.oci.config.environment).map(
        ([key, value]) => `${key}=${value}`,
      ),
      Labels: input.manifest.oci.config.labels,
      WorkingDir: input.manifest.oci.config.workingDirectory ?? '',
      User: input.manifest.oci.config.user ?? '',
    },
    rootfs: { type: 'layers', diff_ids: [layerDigest] },
  } as unknown as JsonValue);
  const configDigest = digest(config);
  const manifest = canonicalBytes({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: {
      mediaType: 'application/vnd.oci.image.config.v1+json',
      digest: configDigest,
      size: config.byteLength,
    },
    layers: [
      {
        mediaType: 'application/vnd.oci.image.layer.v1.tar',
        digest: layerDigest,
        size: layer.byteLength,
      },
    ],
  } as unknown as JsonValue);
  const manifestDigest = digest(manifest);
  const index = canonicalBytes({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [
      {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: manifestDigest,
        size: manifest.byteLength,
        annotations: {
          'org.opencontainers.image.ref.name': input.manifest.target.version,
        },
      },
    ],
  } as unknown as JsonValue);
  const bytes = packTar([
    { path: 'oci-layout', contents: text('{"imageLayoutVersion":"1.0.0"}\n') },
    { path: 'index.json', contents: index },
    { path: `blobs/sha256/${layerDigest.slice(7)}`, contents: layer },
    { path: `blobs/sha256/${configDigest.slice(7)}`, contents: config },
    { path: `blobs/sha256/${manifestDigest.slice(7)}`, contents: manifest },
  ]);
  return artifact(
    `${fileStem(input)}.oci.tar`,
    bytes,
    'application/vnd.oci.image.layout.v1.tar',
    'oci-layout',
    input,
  );
}

function emitDeb(input: NormalizedPackInput): StandardEmitterArtifact {
  const control = input.files.find((file) => file.path === 'DEBIAN/control');
  if (control === undefined)
    throw new ProviderError(
      'INVALID_REQUEST',
      'Debian standard packing requires DEBIAN/control',
    );
  const controlTar = packTarGzip([
    { path: 'control', contents: control.contents },
  ]);
  const dataTar = packTarGzip(
    input.files.filter((file) => !file.path.startsWith('DEBIAN/')),
  );
  return artifact(
    `${fileStem(input)}.deb`,
    packAr([
      { name: 'debian-binary', bytes: text('2.0\n') },
      { name: 'control.tar.gz', bytes: controlTar },
      { name: 'data.tar.gz', bytes: dataTar },
    ]),
    'application/vnd.debian.binary-package',
    'distribution',
    input,
  );
}

function packAr(
  entries: readonly { name: string; bytes: Uint8Array }[],
): Uint8Array {
  const parts: Uint8Array[] = [text('!<arch>\n')];
  for (const entry of entries) {
    if (entry.name.length > 15)
      throw new ProviderError(
        'INVALID_REQUEST',
        `ar member name too long: ${entry.name}`,
      );
    const header = `${`${entry.name}/`.padEnd(16)}${'0'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'100644'.padEnd(8)}${String(entry.bytes.byteLength).padEnd(10)}`;
    parts.push(text(`${header}\u0060\n`), entry.bytes);
    if (entry.bytes.byteLength % 2 !== 0) parts.push(text('\n'));
  }
  return concat(parts);
}

/** Minimal canonical NAR encoder for regular-file project trees. */
function packNar(files: NormalizedPackInput['files']): Uint8Array {
  type Node = {
    files: Map<string, NormalizedPackInput['files'][number]>;
    directories: Map<string, Node>;
  };
  const root: Node = { files: new Map(), directories: new Map() };
  for (const file of files) {
    const parts = file.path.split('/');
    const name = parts.pop()!;
    let node = root;
    for (const part of parts) {
      const next = node.directories.get(part) ?? {
        files: new Map(),
        directories: new Map(),
      };
      node.directories.set(part, next);
      node = next;
    }
    node.files.set(name, file);
  }
  const out: Uint8Array[] = [narString('nix-archive-1')];
  writeNarDirectory(root, out);
  return concat(out);
}

function writeNarDirectory(
  node: {
    files: Map<string, NormalizedPackInput['files'][number]>;
    directories: Map<string, unknown>;
  },
  out: Uint8Array[],
): void {
  out.push(narString('('), narString('type'), narString('directory'));
  const entries = [
    ...[...node.directories].map(([name, child]) => ({ name, child })),
    ...[...node.files].map(([name, file]) => ({ name, file })),
  ].sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    out.push(
      narString('entry'),
      narString('('),
      narString('name'),
      narString(entry.name),
      narString('node'),
    );
    if ('file' in entry) {
      out.push(narString('('), narString('type'), narString('regular'));
      if (entry.file.executable)
        out.push(narString('executable'), narString(''));
      out.push(
        narString('contents'),
        narBytes(entry.file.contents),
        narString(')'),
      );
    } else {
      writeNarDirectory(
        entry.child as Parameters<typeof writeNarDirectory>[0],
        out,
      );
    }
    out.push(narString(')'));
  }
  out.push(narString(')'));
}

function narString(value: string): Uint8Array {
  return narBytes(text(value));
}

function narBytes(bytes: Uint8Array): Uint8Array {
  const length = new Uint8Array(8);
  new DataView(length.buffer).setBigUint64(0, BigInt(bytes.byteLength), true);
  const padding = new Uint8Array((8 - (bytes.byteLength % 8)) % 8);
  return concat([length, bytes, padding]);
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((sum, part) => sum + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
