import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type {
  DelegatedPackProviderManifest,
  PackProviderArgument,
  PackProviderArtifactPattern,
  PackProviderCommandTemplate,
} from '@openpacker/contracts';
import { ProviderError } from '@openpacker/adapter-core';

const MAX_MANIFEST_BYTES = 1_048_576;
const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/u;
const PURL_TYPE = /^[a-z][a-z0-9+.-]*$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const EXECUTABLE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u;
const ROLE = /^[a-z][a-z0-9-]*$/u;
const TOKEN =
  /\{(?:projectRoot|manifestPath|outputDirectory|packageName|packageVersion)\}/gu;

export async function loadDelegatedPackProvider(
  path: string,
): Promise<DelegatedPackProviderManifest> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink())
    invalid(`Provider manifest must be a regular file: ${path}`);
  if (before.size > BigInt(MAX_MANIFEST_BYTES))
    invalid(`Provider manifest exceeds ${MAX_MANIFEST_BYTES} bytes: ${path}`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino)
      invalid(`Provider manifest changed while opening: ${path}`);
    const text = await handle.readFile('utf8');
    const after = await handle.stat({ bigint: true });
    if (
      opened.size !== after.size ||
      opened.mtimeNs !== after.mtimeNs ||
      opened.ctimeNs !== after.ctimeNs
    )
      invalid(`Provider manifest changed while reading: ${path}`);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      invalid(
        `Provider manifest is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return parseDelegatedPackProvider(value);
  } finally {
    await handle.close();
  }
}

export function parseDelegatedPackProvider(
  value: unknown,
): DelegatedPackProviderManifest {
  const root = record(value, 'provider');
  keys(
    root,
    [
      '$schema',
      'delegatedPackProviderVersion',
      'id',
      'displayName',
      'purlTypes',
      'detection',
      'executable',
      'commands',
      'cleanupCommands',
      'environment',
      'authority',
      'artifacts',
    ],
    'provider',
  );
  if (root.delegatedPackProviderVersion !== '1')
    invalid('delegatedPackProviderVersion must be "1"');
  const id = string(root.id, 'id', 255);
  if (!ID.test(id)) invalid('id is not a valid delegated provider id');
  const purlTypes = uniqueStrings(root.purlTypes, 'purlTypes', 64).map(
    (item) => {
      if (!PURL_TYPE.test(item)) invalid(`Invalid purl type: ${item}`);
      return item;
    },
  );
  const detection = record(root.detection, 'detection');
  keys(detection, ['manifestNames'], 'detection');
  const manifestNames = uniqueStrings(
    detection.manifestNames,
    'detection.manifestNames',
    64,
  );
  for (const name of manifestNames) safeBasename(name, 'manifest name');
  const executable = string(root.executable, 'executable', 255);
  if (!EXECUTABLE.test(executable))
    invalid('executable must be a command name');
  const commands = commandList(root.commands, 'commands', false);
  const cleanupCommands = commandList(
    root.cleanupCommands ?? [],
    'cleanupCommands',
    true,
  );
  const authority = record(root.authority, 'authority');
  keys(authority, ['build', 'network', 'environment'], 'authority');
  if (typeof authority.build !== 'boolean')
    invalid('authority.build must be boolean');
  if (!['never', 'consent'].includes(String(authority.network)))
    invalid('authority.network must be never or consent');
  const authorityEnvironment = uniqueStrings(
    authority.environment,
    'authority.environment',
    64,
    true,
  );
  for (const name of authorityEnvironment)
    if (!ENV_NAME.test(name)) invalid(`Invalid environment name: ${name}`);
  const environment: Record<string, string> = {};
  if (root.environment !== undefined) {
    const input = record(root.environment, 'environment');
    if (Object.keys(input).length > 64)
      invalid('environment has too many entries');
    for (const [name, template] of Object.entries(input)) {
      if (!ENV_NAME.test(name)) invalid(`Invalid environment name: ${name}`);
      environment[name] = templateString(template, `environment.${name}`);
    }
  }
  const artifacts = array(root.artifacts, 'artifacts', 64, false).map(
    (item, index) => artifact(item, index),
  );
  return {
    ...(root.$schema === undefined
      ? {}
      : { $schema: string(root.$schema, '$schema', 8192) }),
    delegatedPackProviderVersion: '1',
    id,
    ...(root.displayName === undefined
      ? {}
      : { displayName: string(root.displayName, 'displayName', 255) }),
    purlTypes,
    detection: { manifestNames },
    executable,
    commands,
    ...(cleanupCommands.length === 0 ? {} : { cleanupCommands }),
    ...(Object.keys(environment).length === 0 ? {} : { environment }),
    authority: {
      build: authority.build,
      network: authority.network as 'never' | 'consent',
      environment: authorityEnvironment,
    },
    artifacts,
  };
}

function commandList(
  value: unknown,
  label: string,
  empty: boolean,
): PackProviderCommandTemplate[] {
  return array(value, label, 64, empty).map((item, index) => {
    const command = record(item, `${label}[${index}]`);
    keys(command, ['arguments'], `${label}[${index}]`);
    return {
      arguments: array(
        command.arguments,
        `${label}[${index}].arguments`,
        255,
        true,
      ).map((argument, argumentIndex) =>
        parseArgument(
          argument,
          `${label}[${index}].arguments[${argumentIndex}]`,
        ),
      ),
    };
  });
}

function parseArgument(value: unknown, label: string): PackProviderArgument {
  if (typeof value === 'string') return templateString(value, label);
  const argument = record(value, label);
  keys(argument, ['value', 'when'], label);
  const when = String(argument.when);
  if (
    ![
      'always',
      'allow-build',
      'deny-build',
      'allow-network',
      'offline',
    ].includes(when)
  )
    invalid(`${label}.when is invalid`);
  return {
    value: templateString(argument.value, `${label}.value`),
    when: when as Exclude<PackProviderArgument, string>['when'],
  };
}

function artifact(value: unknown, index: number): PackProviderArtifactPattern {
  const label = `artifacts[${index}]`;
  const input = record(value, label);
  keys(input, ['suffix', 'basename', 'mediaType', 'nativeRole'], label);
  if ((input.suffix === undefined) === (input.basename === undefined))
    invalid(`${label} requires exactly one of suffix or basename`);
  const suffix =
    input.suffix === undefined
      ? undefined
      : string(input.suffix, `${label}.suffix`, 255);
  if (suffix !== undefined && !/^\.[A-Za-z0-9._+-]+$/u.test(suffix))
    invalid(`${label}.suffix is invalid`);
  const basename =
    input.basename === undefined
      ? undefined
      : string(input.basename, `${label}.basename`, 255);
  if (basename !== undefined) safeBasename(basename, `${label}.basename`);
  const mediaType = string(input.mediaType, `${label}.mediaType`, 255);
  if (!MEDIA_TYPE.test(mediaType)) invalid(`${label}.mediaType is invalid`);
  const nativeRole = string(input.nativeRole, `${label}.nativeRole`, 128);
  if (!ROLE.test(nativeRole)) invalid(`${label}.nativeRole is invalid`);
  return suffix === undefined
    ? { basename: basename!, mediaType, nativeRole }
    : { suffix, mediaType, nativeRole };
}

function templateString(value: unknown, label: string): string {
  const result = string(value, label, 8192);
  if (/[{}]/u.test(result.replace(TOKEN, '')))
    invalid(`${label} contains an unknown template token`);
  return result;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function keys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined)
    invalid(`${label} contains unknown field ${unknown}`);
}

function array(
  value: unknown,
  label: string,
  maximum: number,
  empty: boolean,
): unknown[] {
  if (
    !Array.isArray(value) ||
    (!empty && value.length === 0) ||
    value.length > maximum
  )
    invalid(
      `${label} must contain ${empty ? `at most ${maximum}` : `1 to ${maximum}`} items`,
    );
  return value;
}

function uniqueStrings(
  value: unknown,
  label: string,
  maximum: number,
  empty = false,
): string[] {
  const values = array(value, label, maximum, empty).map((item, index) =>
    string(item, `${label}[${index}]`, 255),
  );
  if (new Set(values).size !== values.length)
    invalid(`${label} must be unique`);
  return values;
}

function string(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum)
    invalid(`${label} must be a non-empty string up to ${maximum} characters`);
  return value;
}

function safeBasename(value: string, label: string): void {
  if (
    value === '.' ||
    value === '..' ||
    /[\\/\u0000-\u001f\u007f]/u.test(value)
  )
    invalid(`${label} must be a safe basename`);
}

function invalid(message: string): never {
  throw new ProviderError('INVALID_PROVIDER_MANIFEST', message);
}
