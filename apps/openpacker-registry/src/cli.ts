#!/usr/bin/env node
/**
 * Run a PREX registry.
 *
 * A registry is meant to be reachable, so unlike `openpackerd` this binds where
 * it is told. What it refuses instead is starting with publishing open to
 * anyone unless the operator says so: an unauthenticated registry is the only
 * thing its consumers can check, and that should be a decision rather than a
 * default nobody noticed.
 */

import { createRegistry } from './index.js';

export async function runRegistry(
  argv = process.argv.slice(2),
  io: {
    stdout: { write(text: string): unknown };
    stderr: { write(text: string): unknown };
  } = process,
): Promise<number> {
  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (const argument of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/u.exec(argument);
    if (!match) continue;
    if (match[2] === undefined) flags.add(match[1]!);
    else options.set(match[1]!, match[2]);
  }

  if (flags.has('help')) {
    io.stdout.write(HELP);
    return 0;
  }

  const registryId = options.get('registry-id');
  if (!registryId) {
    io.stderr.write(
      'openpacker-registry: --registry-id is required; it is what a policy pins.\n',
    );
    return 2;
  }

  const anonymous = flags.has('anonymous-publish');
  if (!anonymous && !options.has('publisher-keys')) {
    io.stderr.write(
      'openpacker-registry: refusing to start with no publisher keys and no ' +
        '--anonymous-publish. A registry that accepts unsigned manifests is the ' +
        'only thing its consumers can check; say so deliberately.\n',
    );
    return 2;
  }

  const keysPath = options.get('publisher-keys');
  const publisherKeys = keysPath
    ? // SAFETY: The surrounding boundary establishes the asserted domain contract.
      (JSON.parse(
        await (await import('node:fs/promises')).readFile(keysPath, 'utf8'),
      ) as Record<string, JsonWebKey>)
    : undefined;

  const app = createRegistry({
    registryId,
    purlTypes: (options.get('purl-types') ?? 'npm')
      .split(',')
      .map((type) => type.trim()),
    ...(!(options.get('display-name') === undefined) && {
      displayName: options.get('display-name')!,
    }),
    ...(!(options.get('database') === undefined) && {
      databasePath: options.get('database')!,
    }),
    ...(!(publisherKeys === undefined) && { publisherKeys }),
    ...(anonymous && { anonymousPublish: true }),
  });

  const address = await app.listen({
    host: options.get('host') ?? '127.0.0.1',
    port: Number(options.get('port') ?? '7400'),
  });
  io.stdout.write(`${address}\n`);
  return 0;
}

const HELP = `openpacker-registry — serve PREX package manifests

  --registry-id <urn>        Required. Stable id a policy can pin.
  --purl-types <a,b>         Purl types advertised in the service index.
  --display-name <name>
  --host <host>              Default 127.0.0.1.
  --port <port>              Default 7400.
  --database <path>          SQLite file. Default in-memory.
  --publisher-keys <path>    JSON map of keyId to public JWK.
  --anonymous-publish        Accept unsigned manifests. Say this out loud.
`;

if (
  process.argv[1] &&
  import.meta.url ===
    (await import('node:url')).pathToFileURL(process.argv[1]).href
)
  process.exitCode = await runRegistry();
