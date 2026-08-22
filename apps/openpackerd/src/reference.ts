import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { tryGetAdapterRegistry } from '@openpacker/adapter-host';
import {
  canonicalDigest,
  canonicalProjectionDigest,
  parseCanonicalJson,
} from '@openpacker/canonical';
import {
  DIGEST_PROJECTIONS,
  type JsonValue,
  type ResolutionUniverse,
} from '@openpacker/contracts';
import { createEmbeddedResolver } from '@openpacker/embedded';
import * as bindings from '@openpacker/embedded/wasm-node';
import {
  createReferenceOperations,
  OperationError,
  type PrexOperations,
} from './operations.js';
import { createFilesystemPublishStore } from './publish-store.js';

/** Ensure the process adapter registry is populated for the reference daemon. */
export function ensureReferenceAdapters(): void {
  if (!tryGetAdapterRegistry()) configureDefaultAdapters();
}

export async function createStandaloneReferenceOperations(
  universePath?: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<PrexOperations> {
  ensureReferenceAdapters();
  const universe = universePath
    ? // SAFETY: The surrounding boundary establishes the asserted domain contract.
      (parseCanonicalJson(
        await readFile(universePath, 'utf8'),
      ) as ResolutionUniverse)
    : await emptyUniverse();
  const resolver = createEmbeddedResolver(bindings);
  resolver.validateUniverse(universe);
  const unavailable = async (): Promise<never> => {
    throw new OperationError(
      'PROVIDER_CAPABILITY_MISSING',
      'This standalone operation requires an explicitly configured extension',
      501,
    );
  };
  const env = options.env ?? process.env;
  const publishRoot = env.OPENPACKER_PUBLISH_STORE?.trim();
  const publishStore =
    publishRoot === undefined || publishRoot === ''
      ? undefined
      : createFilesystemPublishStore({
          root: absolutePublishStore(publishRoot),
        });
  return createReferenceOperations({
    universe,
    resolver,
    meta: {
      protocolVersion: '1.0-draft',
      provider: {
        id: 'org.openpacker.reference',
        implementation: 'openpackerd',
        version: '0.1.0',
      },
    },
    resolverBuildDigest: await canonicalDigest({
      implementation: 'openpacker-wasm',
      version: '0.1.0',
    }),
    extensions: {
      lifecycleApply: publishStore
        ? (input, context) => publishStore.lifecycleApply(input, context)
        : unavailable,
      pack: unavailable,
      publish: publishStore
        ? (input, context) => publishStore.publish(input, context)
        : unavailable,
    },
  });
}

function absolutePublishStore(root: string): string {
  if (!isAbsolute(root))
    throw new RangeError(
      'OPENPACKER_PUBLISH_STORE must be an absolute directory so OPENPACKER_HOST cannot accidentally publish',
    );
  return root;
}

async function emptyUniverse(): Promise<ResolutionUniverse> {
  const lifecycleRoot = await canonicalDigest([]);
  const body: Omit<ResolutionUniverse, 'canonicalDigest'> = {
    universeVersion: '1',
    packages: [],
    overlays: [],
    sourceSnapshots: [],
    lifecycleRoot,
    targetVocabularyVersion: '1',
  };
  const projection = DIGEST_PROJECTIONS.projections.find(
    ({ id }) => id === 'universe-v1',
  );
  if (!projection) throw new Error('Missing universe-v1 projection');
  return {
    ...body,
    canonicalDigest: await canonicalProjectionDigest(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      JSON.parse(JSON.stringify(body)) as JsonValue,
      projection,
    ),
  };
}
