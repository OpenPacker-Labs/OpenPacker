#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { isAbsolute, relative } from 'node:path';
import { get } from 'node:https';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isPrivateAddress } from '@openpacker/adapter-core';
import {
  streamFromBytes,
  type ArtifactSource,
} from '@openpacker/artifact-model';
import { materialize, type ArchiveFormat } from '@openpacker/materializer';
import { extractionLimits } from './extraction.js';
import {
  canonicalBytes,
  canonicalDigest,
  compareCanonicalStrings,
  formatDigest,
  OverlongHostError,
  parseCanonicalJson,
  out,
  outJson,
  parseDigest,
  parseUntrustedUrl,
  report,
} from '@openpacker/canonical';
import { validateContract } from '@openpacker/conformance';
import type {
  ExternalRef,
  ArtifactDescriptor,
  JsonValue,
  OpenPackerLockfile,
  SignedReceipt,
  SolveResponse,
  VerifyRequest,
} from '@openpacker/contracts';
import {
  OpenPackerClient,
  PrexClientError,
  type RawResponse,
  type RequestOptions,
} from '@openpacker/sdk';

export const EXIT_CODES = {
  success: 0,
  usage: 2,
  invalidInput: 3,
  notFound: 4,
  unsatisfiable: 5,
  policyDenied: 6,
  verificationFailed: 7,
  unavailable: 8,
  internal: 9,
} as const;

export interface CliIo {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
  stdin: NodeJS.ReadableStream;
}

interface ParsedArguments {
  command: string;
  subcommand?: string;
  positionals: string[];
  options: Map<string, string | true>;
}

const COMMANDS = new Set([
  'normalize',
  'identify',
  'enumerate',
  'inspect',
  'solve',
  'resolve',
  'explain',
  'materialize',
  'verify',
  'pack',
  'publish',
  'receipt',
  'catalog',
  'import-lock',
  'lifecycle',
  'export',
  'serve',
  'demo',
]);
const BOOLEAN_OPTIONS = new Set(['json', 'offline', 'help']);
const LOCKFILE_SCHEMA =
  'https://openpacker.dev/spec/prex/v1/schemas/lockfile.schema.json';

export async function runCli(
  argv = process.argv.slice(2),
  io: CliIo = process,
): Promise<number> {
  try {
    const args = parseArguments(argv);
    if (args.options.has('help')) {
      out(io, help());
      return EXIT_CODES.success;
    }
    if (!COMMANDS.has(args.command))
      throw new UsageError(`Unknown command: ${args.command || '(missing)'}`);
    if (args.command === 'serve') return await serve(args, io);
    if (args.command === 'demo') return await demo(args, io);
    const baseUrl =
      option(args, 'base-url') ??
      process.env.OPENPACKER_URL ??
      'http://127.0.0.1:7337';
    if (args.options.has('offline') && !isLoopback(baseUrl))
      throw new UsageError(
        '--offline permits only a loopback OpenPacker service URL',
      );
    if (args.command === 'publish' && args.options.has('offline'))
      throw new UsageError('publish cannot run with --offline');
    const headers: Record<string, string> = {};
    if (args.options.has('offline')) headers['x-openpacker-offline'] = 'true';
    const tokenFile = option(args, 'auth-token-file');
    if (tokenFile) {
      const token = (await readFile(tokenFile, 'utf8')).trim();
      if (!token || /[\r\n]/u.test(token))
        throw new InputError(
          'Authentication token file must contain one non-empty line',
        );
      headers.authorization = `Bearer ${token}`;
    }
    const client = new OpenPackerClient({
      baseUrl,
      ...(!(Object.keys(headers).length === 0) && { headers }),
      timeoutMilliseconds: numberOption(args, 'timeout', 30_000),
    });
    const requestOptions: RequestOptions = {
      ...(!(option(args, 'idempotency-key') === undefined) && {
        idempotencyKey: option(args, 'idempotency-key')!,
      }),
    };
    const result = await execute(args, client, requestOptions, io);
    if (result !== undefined)
      await output(args, io, result.data, result.rawBytes);
    return verifyDecisionExitCode(args, result?.data) ?? EXIT_CODES.success;
  } catch (error) {
    const code = exitCode(error);
    const message =
      error instanceof Error ? error.message : 'Unknown OpenPacker CLI error';
    const json = argv.includes('--json');
    // The one writer of an error (`report`): the message is a server's, a file's
    // or an argument's text, and is made plain whether it is a line or a field
    // of the JSON document.
    io.stderr.write(
      report(
        json ? '' : 'openpacker: ',
        json
          ? JSON.stringify({
              error: {
                message,
                exitCode: code,
                ...(error instanceof PrexClientError &&
                  error.problem && { problem: error.problem }),
              },
            })
          : message,
      ),
    );
    return code;
  }
}

async function execute(
  args: ParsedArguments,
  client: OpenPackerClient,
  requestOptions: RequestOptions,
  io: CliIo,
): Promise<RawResponse<unknown> | undefined> {
  if (args.command === 'receipt' && args.subcommand === 'inspect') {
    const digest = parseDigest(requiredPositional(args, 0, 'receipt digest'));
    return client.receipt(digest.algorithm, digest.value, requestOptions);
  }
  if (args.command === 'export') {
    const input = await inputObject(args, io);
    const exported =
      args.subcommand === 'lock'
        ? await exportLock(input)
        : args.subcommand === 'sbom'
          ? exportSbom(input)
          : undefined;
    if (!exported) throw new UsageError('export requires `lock` or `sbom`');
    const bytes = canonicalBytes(exported);
    const destination = option(args, 'output');
    if (destination) await writeFile(destination, bytes);
    return {
      data: exported,
      rawBytes: bytes,
      response: new Response(Uint8Array.from(bytes).buffer),
    };
  }
  const input = await commandInput(args, io);
  switch (`${args.command}${args.subcommand ? ` ${args.subcommand}` : ''}`) {
    case 'normalize':
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      return client.normalize(input as never, requestOptions);
    case 'identify':
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      return client.identify(input as never, requestOptions);
    case 'enumerate':
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      return client.enumerate(input as never, requestOptions);
    case 'inspect':
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      return client.inspect(input as never, requestOptions);
    case 'solve':
    case 'resolve':
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      return client.solve(input as never, requestOptions);
    case 'import-lock':
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      return client.lockImport(input as never, requestOptions);
    case 'explain':
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      return client.explain(input as never, requestOptions);
    case 'materialize': {
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      const response = await client.materialize(input as never, requestOptions);
      const destination = option(args, 'install-prefix');
      if (!destination) return response;
      const { descriptor } = response.data;
      const source = locationSource(descriptor, args.options.has('offline'));
      await source.stat(descriptor);
      const installation = await materialize({
        source,
        descriptor,
        destination,
        format: archiveFormat(descriptor),
        limits: extractionLimits(descriptor),
        managedDestination: true,
      });
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      const data = JSON.parse(
        JSON.stringify({ ...response.data, installation }),
      ) as JsonValue;
      return {
        data,
        rawBytes: canonicalBytes(data),
        response: response.response,
      };
    }
    case 'verify':
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      return client.verify(input as never, requestOptions);
    case 'pack':
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      return client.pack(input as never, requestOptions);
    case 'publish':
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      return client.publish(input as never, requestOptions);
    case 'receipt verify':
      return client.verify(
        receiptVerifyInput(input, option(args, 'evaluation-time')),
        requestOptions,
      );
    case 'catalog import':
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      return client.catalogImport(input as never, requestOptions);
    case 'catalog snapshot':
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      return client.catalogSnapshot(input as never, requestOptions);
    case 'lifecycle apply':
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      return client.lifecycleApply(input as never, requestOptions);
    default:
      throw new UsageError(
        `Unsupported command: ${args.command}${args.subcommand ? ` ${args.subcommand}` : ''}`,
      );
  }
}

async function commandInput(
  args: ParsedArguments,
  io: CliIo,
): Promise<JsonValue> {
  if (args.command === 'import-lock')
    return importLockInput(args, io, await optionalPolicy(args));
  let value: JsonValue;
  if (
    option(args, 'input') !== undefined ||
    args.positionals.length === 0 ||
    ['solve', 'verify', 'pack', 'publish', 'resolve'].includes(args.command) ||
    args.subcommand !== undefined
  ) {
    value = await inputObject(args, io);
  } else {
    const positional = requiredPositional(args, 0, 'package value');
    if (args.command === 'normalize')
      value = {
        items: [{ type: inferNormalizeType(positional), value: positional }],
      };
    else if (args.command === 'identify')
      value = {
        query: positional.startsWith('pkg:')
          ? { purl: positional }
          : { alias: positional },
      };
    else if (args.command === 'enumerate')
      value = {
        canonicalPurl: positional,
        target: {},
        lifecyclePolicy: { includeYanked: false, includeDelisted: false },
        page: { size: numberOption(args, 'page-size', 100) },
      };
    else if (args.command === 'inspect')
      value = { exact: { exactPurl: positional } };
    else if (args.command === 'explain')
      value = { solutionDigest: parseDigest(positional), format: 'both' };
    else if (args.command === 'materialize')
      value = {
        subject: positional.startsWith('sha256:')
          ? { type: 'digest', digest: parseDigest(positional) }
          : { type: 'purl', exactPurl: positional },
      };
    else throw new UsageError(`${args.command} requires --input <file|->`);
  }
  return applyOverrides(value, args, await optionalPolicy(args));
}

async function inputObject(
  args: ParsedArguments,
  io: CliIo,
): Promise<JsonValue> {
  const source = option(args, 'input');
  if (source === undefined)
    throw new UsageError('This command requires --input <file|->');
  const text =
    source === '-' ? await readStdin(io.stdin) : await readFile(source, 'utf8');
  const value = parseCanonicalJson(text);
  if (typeof value !== 'object' || value === null)
    throw new InputError('Input must be a JSON object');
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  return value as JsonValue;
}

async function importLockInput(
  args: ParsedArguments,
  io: CliIo,
  policy: JsonValue | undefined,
) {
  const source =
    option(args, 'input') ??
    (args.positionals[0] !== undefined ? args.positionals[0] : undefined);
  if (source === undefined)
    throw new UsageError('import-lock requires --input <lockfile|->');
  const text =
    source === '-' ? await readStdin(io.stdin) : await readFile(source, 'utf8');
  // Accept either a LockImportRequest JSON object or a raw native lockfile body.
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      const parsed = parseCanonicalJson(trimmed) as Record<string, unknown>;
      if (typeof parsed.lockfile === 'string') {
        const result: Record<string, JsonValue> = {
          // SAFETY: The surrounding boundary establishes the asserted domain contract.
          ...(parsed as Record<string, JsonValue>),
        };
        const format = option(args, 'format');
        if (format) result.format = format;
        const ecosystem = option(args, 'ecosystem');
        if (ecosystem) result.ecosystem = ecosystem;
        const evaluationTime = option(args, 'evaluation-time');
        if (evaluationTime) result.evaluationTime = evaluationTime;
        if (policy !== undefined) result.policy = policy;
        const target = option(args, 'target');
        if (target) result.target = parseTarget(target);
        return result;
      }
    } catch {
      // fall through — treat as raw lock JSON (e.g. package-lock)
    }
  }
  const result: Record<string, JsonValue> = { lockfile: text };
  const format = option(args, 'format');
  if (format) result.format = format;
  else result.format = 'auto';
  const ecosystem = option(args, 'ecosystem');
  if (ecosystem) result.ecosystem = ecosystem;
  const evaluationTime = option(args, 'evaluation-time');
  if (evaluationTime) result.evaluationTime = evaluationTime;
  if (policy !== undefined) result.policy = policy;
  const target = option(args, 'target');
  if (target) result.target = parseTarget(target);
  return result;
}

function applyOverrides(
  input: JsonValue,
  args: ParsedArguments,
  policy: JsonValue | undefined,
) {
  if (!isObject(input))
    throw new InputError('Command input must be a JSON object');
  const result: Record<string, JsonValue> = { ...input };
  const target = option(args, 'target');
  if (target) result.target = parseTarget(target);
  if (policy !== undefined) result.policy = policy;
  const evaluationTime = option(args, 'evaluation-time');
  if (evaluationTime) result.evaluationTime = evaluationTime;
  return result;
}

async function optionalPolicy(
  args: ParsedArguments,
): Promise<JsonValue | undefined> {
  const path = option(args, 'policy-file');
  return path ? parseCanonicalJson(await readFile(path, 'utf8')) : undefined;
}

function receiptVerifyInput(
  input: JsonValue,
  evaluationTime?: string,
): VerifyRequest {
  const signed =
    isObject(input) && 'receipt' in input
      ? // SAFETY: The surrounding boundary establishes the asserted domain contract.
        (input as SignedReceipt)
      : isObject(input) && isObject(input.signedReceipt)
        ? // SAFETY: The surrounding boundary establishes the asserted domain contract.
          (input.signedReceipt as SignedReceipt)
        : undefined;
  if (!signed)
    throw new InputError('receipt verify requires a SignedReceipt input');
  return {
    subject: signed,
    checks: ['receipt-signature', 'receipt-bindings'],
    evaluationTime: evaluationTime ?? signed.receipt.evaluationTime,
  };
}

async function exportLock(input: JsonValue): Promise<JsonValue> {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const solve = input as SolveResponse;
  if (
    !solve.normalizedRequest ||
    !solve.solution ||
    !solve.unsignedReceipt ||
    !solve.selected
  )
    throw new InputError('export lock requires a SolveResponse');
  const receiptDigest =
    solve.signedReceipt?.receiptDigest ??
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    (await canonicalDigest(
      JSON.parse(JSON.stringify(solve.unsignedReceipt)) as JsonValue,
    ));
  const artifacts = solve.selected.flatMap((item) => item.artifacts);
  const externalRefs = uniqueExternalRefs([
    ...solve.unsignedReceipt.externalRefs,
    ...solve.selected.flatMap((item) => [
      ...item.identity.externalRefs,
      ...item.artifacts.flatMap((artifact) => artifact.externalRefs),
    ]),
  ]).filter((reference) => !reference.type.startsWith('ocm'));
  const lock: OpenPackerLockfile = {
    schemaVersion: '1',
    protocolVersion: '1.0-draft',
    rootRequirements: solve.normalizedRequest.requirements,
    target: solve.normalizedRequest.target,
    semanticsProfile: solve.normalizedRequest.semantics.profile,
    objectiveOrdering: solve.normalizedRequest.objectives,
    selectedExactPurls: solve.selected
      .map((item) => item.identity.exactPurl)
      .filter((value): value is string => value !== undefined)
      .sort(),
    dependencyEdges: solve.solution.dependencyEdges,
    artifactDescriptors: artifacts,
    ocmReferences: artifacts.flatMap((artifact) =>
      artifact.externalRefs.filter((reference) =>
        reference.type.startsWith('ocm'),
      ),
    ),
    sourceSnapshotDigests: solve.solution.sourceSnapshotDigests,
    lifecycleRoot: solve.unsignedReceipt.lifecycleRoot,
    policyDigest: solve.unsignedReceipt.policyDigest,
    solutionDigest: solve.solution.solutionDigest,
    receiptDigest,
    externalRefs,
  };
  const validation = validateContract(
    LOCKFILE_SCHEMA,
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    JSON.parse(JSON.stringify(lock)) as JsonValue,
  );
  if (!validation.valid)
    throw new InputError(
      `export lock produced an invalid lockfile: ${validation.errors.map((error) => `${error.instancePath || '/'} ${error.message ?? 'invalid value'}`).join('; ')}`,
    );
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  return JSON.parse(JSON.stringify(lock)) as JsonValue;
}

function exportSbom(input: JsonValue): JsonValue {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const solve = input as SolveResponse;
  if (!solve.selected || !solve.solution)
    throw new InputError('export sbom requires a SolveResponse');
  const componentRefs = new Map(
    solve.selected.map((item) => [
      item.nodeId,
      `urn:openpacker:component:${item.nodeId}`,
    ]),
  );
  if (componentRefs.size !== solve.selected.length)
    throw new InputError('export sbom requires unique selected node IDs');
  const dependencyRefs = new Map<string, string[]>();
  for (const item of solve.selected) {
    const dependsOn = solve.solution.dependencyEdges
      .filter((edge) => edge.fromNodeId === item.nodeId)
      .map((edge) => {
        const reference = componentRefs.get(edge.toNodeId);
        if (!reference)
          throw new InputError(
            `export sbom dependency target is not selected: ${edge.toNodeId}`,
          );
        return reference;
      })
      .sort();
    dependencyRefs.set(item.nodeId, [...new Set(dependsOn)]);
  }
  const solutionDigest = formatDigest(solve.solution.solutionDigest);
  const solutionRef = `urn:openpacker:solution:${solutionDigest}`;
  const incoming = new Set(
    solve.solution.dependencyEdges.map((edge) => edge.toNodeId),
  );
  const rootIds = solve.selected
    .map((item) => item.nodeId)
    .filter((id) => !incoming.has(id));
  const rootRefs = (
    rootIds.length > 0 ? rootIds : solve.selected.map((item) => item.nodeId)
  )
    .map((id) => componentRefs.get(id)!)
    .sort();
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: deterministicUuid(solve.solution.solutionDigest.value),
    version: 1,
    metadata: {
      component: {
        'bom-ref': solutionRef,
        type: 'application',
        name: 'openpacker-solution',
        version: solutionDigest,
      },
    },
    components: solve.selected.map((item) => ({
      'bom-ref': componentRefs.get(item.nodeId)!,
      type: 'library',
      name: item.identity.name,
      version: item.normalizedVersion,
      ...(!(item.identity.exactPurl === undefined) && {
        purl: item.identity.exactPurl,
      }),
      hashes: item.artifacts.map((artifact) => ({
        alg: 'SHA-256',
        content: artifact.digest.value,
      })),
    })),
    dependencies: [
      { ref: solutionRef, dependsOn: rootRefs },
      ...solve.selected.map((item) => ({
        ref: componentRefs.get(item.nodeId)!,
        dependsOn: dependencyRefs.get(item.nodeId)!,
      })),
    ],
  };
}

function uniqueExternalRefs(references: readonly ExternalRef[]): ExternalRef[] {
  return [
    ...new Map(
      references.map((reference) => [
        `${reference.type}\u0000${reference.locator}`,
        reference,
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      compareCanonicalStrings(left.type, right.type) ||
      compareCanonicalStrings(left.locator, right.locator),
  );
}

function deterministicUuid(digest: string): string {
  if (!/^[0-9a-f]{64}$/u.test(digest))
    throw new InputError('export sbom requires a sha256 solution digest');
  const hex = digest.slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `urn:uuid:${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

async function output(
  args: ParsedArguments,
  io: CliIo,
  value: unknown,
  rawBytes: Uint8Array,
): Promise<void> {
  const destination = option(args, 'output');
  if (destination) await writeFile(destination, rawBytes);
  if (args.options.has('json')) outJson(io, new TextDecoder().decode(rawBytes));
  else outJson(io, JSON.stringify(redact(value), null, 2));
}

async function serve(args: ParsedArguments, io: CliIo): Promise<number> {
  const modulePath =
    option(args, 'operations-module') ??
    process.env.OPENPACKER_OPERATIONS_MODULE;
  const { createStandaloneReferenceOperations, startOpenPackerDaemon } =
    await import('@openpacker/openpackerd');
  const operations = modulePath
    ? await loadOperations(modulePath)
    : await createStandaloneReferenceOperations(
        option(args, 'universe') ?? process.env.OPENPACKER_UNIVERSE,
      );
  const server = await startOpenPackerDaemon({
    operations,
    databasePath: option(args, 'database') ?? '.openpacker/openpackerd.sqlite',
    host: option(args, 'host') ?? '127.0.0.1',
    port: numberOption(args, 'port', 7337),
    logger: !args.options.has('json'),
  });
  if (args.options.has('json'))
    outJson(io, JSON.stringify({ address: server.address }));
  else out(io, `openpackerd listening at ${server.address}\n`);
  await new Promise<void>((resolve) => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, () => void server.close().then(resolve));
  });
  return EXIT_CODES.success;
}

async function loadOperations(
  modulePath: string,
): Promise<import('@openpacker/openpackerd').PrexOperations> {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const loaded = (await import(pathToFileURL(modulePath).href)) as {
    default?: import('@openpacker/openpackerd').PrexOperations;
    operations?: import('@openpacker/openpackerd').PrexOperations;
  };
  const operations = loaded.operations ?? loaded.default;
  if (!operations)
    throw new InputError(
      'Operations module must export `operations` or default PrexOperations',
    );
  return operations;
}

async function demo(args: ParsedArguments, io: CliIo): Promise<number> {
  const modulePath =
    option(args, 'workflow-module') ?? process.env.OPENPACKER_DEMO_MODULE;
  if (!modulePath)
    throw new UsageError(
      'demo requires OPENPACKER_DEMO_MODULE or --workflow-module; no fake demo path is available',
    );
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const loaded = (await import(pathToFileURL(modulePath).href)) as {
    runOpenPackerDemo?: (input: {
      output: string;
      evaluationTime: string;
      offline: boolean;
    }) => Promise<JsonValue>;
  };
  if (!loaded.runOpenPackerDemo)
    throw new InputError('Demo module must export runOpenPackerDemo');
  const result = await loaded.runOpenPackerDemo({
    output: option(args, 'output') ?? '.demo-output',
    evaluationTime: option(args, 'evaluation-time') ?? '2026-08-02T00:00:00Z',
    offline: args.options.has('offline'),
  });
  const bytes = canonicalBytes(result);
  outJson(
    io,
    args.options.has('json')
      ? new TextDecoder().decode(bytes)
      : JSON.stringify(result, null, 2),
  );
  return EXIT_CODES.success;
}

function parseArguments(argv: string[]): ParsedArguments {
  const options = new Map<string, string | true>();
  const words: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) {
      words.push(token);
      continue;
    }
    const equal = token.indexOf('=');
    const key = token.slice(2, equal < 0 ? undefined : equal);
    if (!key) throw new UsageError('Empty option name');
    if (equal >= 0) options.set(key, token.slice(equal + 1));
    else if (BOOLEAN_OPTIONS.has(key)) options.set(key, true);
    else {
      const value = argv[++index];
      if (!value || value.startsWith('--'))
        throw new UsageError(`--${key} requires a value`);
      options.set(key, value);
    }
  }
  const command = words.shift() ?? '';
  const nested = ['receipt', 'catalog', 'lifecycle', 'export'].includes(command)
    ? words.shift()
    : undefined;
  return {
    command,
    ...(!(nested === undefined) && { subcommand: nested }),
    positionals: words,
    options,
  };
}

function option(args: ParsedArguments, key: string): string | undefined {
  const value = args.options.get(key);
  return typeof value === 'string' ? value : undefined;
}
function numberOption(
  args: ParsedArguments,
  key: string,
  fallback: number,
): number {
  const raw = option(args, key);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new UsageError(`--${key} must be a positive integer`);
  return value;
}
function requiredPositional(
  args: ParsedArguments,
  index: number,
  description: string,
): string {
  const value = args.positionals[index];
  if (!value) throw new UsageError(`Missing ${description}`);
  return value;
}
function inferNormalizeType(value: string): string {
  return value.startsWith('pkg:')
    ? 'purl'
    : value.startsWith('vers:')
      ? 'vers'
      : value.startsWith('sha256:')
        ? 'digest'
        : 'native-coordinate';
}

function parseTarget(value: string): JsonValue {
  if (value.startsWith('{')) return parseCanonicalJson(value);
  const [os, architecture, ...extra] = value.split('/');
  if (!os || !architecture || extra.length)
    throw new UsageError('--target must be JSON or os/architecture');
  return { os, architecture };
}

/**
 * The address a provider gave for an artifact, read through the guard: a host no
 * DNS name could be is refused without the URL parser spending most of a second
 * on it, and the address is not repeated.
 */
function providerLocation(uri: string): URL {
  try {
    return parseUntrustedUrl(uri);
  } catch (error) {
    if (error instanceof OverlongHostError) throw error;
    throw new InputError('Provider artifact location is not a URL');
  }
}

function locationSource(
  descriptor: ArtifactDescriptor,
  offline: boolean,
): ArtifactSource {
  const location = [...descriptor.locations]
    .sort((left, right) => left.priority - right.priority)
    .find(
      ({ transport }) =>
        transport === 'file' || (!offline && transport === 'https'),
    );
  if (!location)
    throw new InputError('No artifact location is permitted by offline policy');
  providerLocation(location.uri);
  return {
    stat: async () => {
      if (location.transport === 'file' || location.transport === 'https')
        providerLocation(location.uri);
      return { descriptor, rangeSupported: location.rangeSupported };
    },
    open: async (_descriptor, _range, signal) => {
      signal?.throwIfAborted();
      if (location.transport === 'file') {
        const root = await realpath(process.cwd());
        const artifact = await realpath(
          fileURLToPath(providerLocation(location.uri)),
        );
        const fromRoot = relative(root, artifact);
        if (
          fromRoot === '..' ||
          fromRoot.startsWith(
            `..${process.platform === 'win32' ? '\\' : '/'}`,
          ) ||
          isAbsolute(fromRoot)
        )
          throw new InputError(
            'Provider artifact file is outside the CLI working directory',
          );
        return streamFromBytes(await readFile(artifact));
      }
      const url = providerLocation(location.uri);
      if (url.protocol !== 'https:' || url.username || url.password)
        throw new InputError(
          'Provider artifact locations must use credential-free HTTPS',
        );
      const hostname = url.hostname.replace(/^\[|\]$/gu, '');
      const addresses = isIP(hostname)
        ? [{ address: hostname, family: isIP(hostname) }]
        : await lookup(hostname, { all: true });
      if (
        addresses.length === 0 ||
        addresses.some(({ address }) => isPrivateAddress(address))
      )
        throw new InputError(
          'Provider artifact location resolves to a private or local address',
        );
      return pinnedHttpsStream(url, addresses[0]!, signal);
    },
    listReferrers: async () => [],
  };
}

async function pinnedHttpsStream(
  url: URL,
  resolved: { address: string; family: number },
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const deadline = AbortSignal.timeout(30_000);
  const boundedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  return new Promise((resolve, reject) => {
    const request = get(
      url,
      {
        signal: boundedSignal,
        lookup: (_hostname, _options, callback) =>
          callback(null, resolved.address, resolved.family),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          response.destroy();
          reject(
            new InputError(`Artifact download failed with HTTP ${status}`),
          );
          return;
        }
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        resolve(Readable.toWeb(response) as ReadableStream<Uint8Array>);
      },
    );
    request.once('error', reject);
  });
}

function embeddedIpv4Address(value: string): string | undefined {
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/iu.exec(value);
  if (hex) {
    const high = parseInt(hex[1]!, 16);
    const low = parseInt(hex[2]!, 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  }
  return /^(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(value)?.[1];
}

function mappedIpv4Address(value: string): string | undefined {
  if (!value.startsWith('::ffff:')) return undefined;
  return embeddedIpv4Address(value.slice('::ffff:'.length));
}

function archiveFormat(descriptor: ArtifactDescriptor): ArchiveFormat {
  const name = descriptor.fileName?.toLowerCase() ?? '';
  if (name.endsWith('.zip') || name.endsWith('.nupkg')) return 'zip';
  if (
    name.endsWith('.tar.gz') ||
    name.endsWith('.tgz') ||
    name.endsWith('.crate') ||
    descriptor.mediaType.includes('gzip')
  )
    return 'tar+gzip';
  if (name.endsWith('.tar') || descriptor.mediaType.includes('tar'))
    return 'tar';
  throw new InputError(
    'Artifact archive format requires a recognized media type or file name',
  );
}

/**
 * Whether a service URL stays on this machine.
 *
 * Loopback is `127.0.0.0/8`, not the single address `127.0.0.1` — a daemon on
 * `127.0.0.2` is every bit as local, and refusing it made `--offline` reject
 * setups that never leave the host. Everything outside the range still fails,
 * so the guarantee `--offline` makes is unchanged.
 */
function isLoopback(value: string): boolean {
  try {
    const { hostname } = parseUntrustedUrl(value);
    if (hostname === 'localhost') return true;
    const host =
      hostname.startsWith('[') && hostname.endsWith(']')
        ? hostname.slice(1, -1)
        : hostname;
    if (host === '::1') return true;
    // IPv4-mapped IPv6 reaches the same v4 stack. WHATWG URL rewrites
    // `::ffff:127.0.0.1` to the hex form `::ffff:7f00:1`, so read that.
    const mapped = mappedIpv4Address(host);
    const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(
      mapped ?? host,
    );
    if (!octets) return false;
    return (
      octets.slice(1).every((octet) => Number(octet) <= 255) &&
      Number(octets[1]) === 127
    );
  } catch {
    return false;
  }
}
function isObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function redact(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(redact);
  if (!isObject(value)) {
    // SAFETY: The redaction input is the validated JSON response body.
    return value as JsonValue;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      /authorization|password|secret|token|credential/iu.test(key)
        ? '[REDACTED]'
        : redact(entry),
    ]),
  );
}

async function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function exitCode(error: unknown): number {
  if (error instanceof UsageError) return EXIT_CODES.usage;
  if (
    error instanceof InputError ||
    error instanceof OverlongHostError ||
    error instanceof SyntaxError ||
    error instanceof TypeError ||
    error instanceof RangeError
  )
    return EXIT_CODES.invalidInput;
  if (error instanceof PrexClientError) {
    const code = error.problem?.code;
    if (
      [
        'PACKAGE_NOT_FOUND',
        'VERSION_NOT_FOUND',
        'SNAPSHOT_NOT_FOUND',
        'ARTIFACT_NOT_FOUND',
      ].includes(code ?? '')
    )
      return EXIT_CODES.notFound;
    if (code === 'UNSATISFIABLE') return EXIT_CODES.unsatisfiable;
    if (
      ['POLICY_DENIED', 'LIFECYCLE_DENIED', 'SEMANTIC_LOSS_REJECTED'].includes(
        code ?? '',
      )
    )
      return EXIT_CODES.policyDenied;
    if (
      [
        'DIGEST_MISMATCH',
        'SIZE_MISMATCH',
        'INVALID_SIGNATURE',
        'PROVENANCE_MISMATCH',
        'STALE_METADATA',
      ].includes(code ?? '')
    )
      return EXIT_CODES.verificationFailed;
    if (error.problem?.retryable || error.status >= 500)
      return EXIT_CODES.unavailable;
  }
  return EXIT_CODES.internal;
}

function verifyDecisionExitCode(
  args: ParsedArguments,
  data: unknown,
): number | undefined {
  const isVerify =
    args.command === 'verify' ||
    (args.command === 'receipt' && args.subcommand === 'verify');
  if (!isVerify || data === undefined) return undefined;
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const { decision, evidence } = data as {
    decision?: string;
    evidence?: { status?: string }[];
  };
  if (decision === 'allow') return undefined;
  if (decision === 'indeterminate') return EXIT_CODES.unavailable;
  if (decision === 'deny')
    return evidence?.some(({ status }) => status === 'policy-denied')
      ? EXIT_CODES.policyDenied
      : EXIT_CODES.verificationFailed;
  return EXIT_CODES.internal;
}

class UsageError extends Error {
  override name = 'UsageError';
}
class InputError extends Error {
  override name = 'InputError';
}

function help(): string {
  return `Usage: opm <command> [subcommand] [options]\n\nPREX control plane:\n  normalize identify enumerate inspect solve resolve explain materialize verify pack publish\n  import-lock\n  receipt inspect|verify\n  catalog import|snapshot\n  lifecycle apply\n  export lock|sbom\n  serve demo\n\nProject manager:\n  init import add remove install ci sync update run exec list …\n\nCommon PREX options: --input <file|-> --json --offline --base-url <url> --target <os/arch|json> --policy-file <file> --auth-token-file <file>\nimport-lock: --input <lockfile> [--format auto|package-lock|cargo-lock|nuget-assets|...] [--json] [--output <lock.json>]\nServe options: --operations-module <path> --database <path> --host <host> --port <port>\nDemo options: --workflow-module <path> --output <directory> --evaluation-time <timestamp>\n`;
}

if (
  import.meta.url ===
  pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : '').href
)
  process.exitCode = await runCli();
