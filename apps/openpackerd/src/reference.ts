import { readFile } from 'node:fs/promises';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { tryGetAdapterRegistry } from '@openpacker/adapter-host';
import { canonicalDigest, parseCanonicalJson } from '@openpacker/canonical';
import type { JsonValue, ResolutionUniverse } from '@openpacker/contracts';
import { createEmbeddedResolver } from '@openpacker/embedded';
import * as bindings from '@openpacker/embedded/wasm-node';
import {
  createReferenceOperations,
  OperationError,
  type PrexOperations,
} from './operations.js';

/** Ensure the process adapter registry is populated for the reference daemon. */
export function ensureReferenceAdapters(): void {
  if (!tryGetAdapterRegistry()) configureDefaultAdapters();
}

export async function createStandaloneReferenceOperations(
  universePath?: string,
): Promise<PrexOperations> {
  ensureReferenceAdapters();
  const universe = universePath
    ? (parseCanonicalJson(
        await readFile(universePath, 'utf8'),
      ) as unknown as ResolutionUniverse)
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
      lifecycleApply: unavailable,
      pack: unavailable,
      publish: unavailable,
    },
  });
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
  return {
    ...body,
    canonicalDigest: await canonicalDigest(body as unknown as JsonValue),
  };
}
