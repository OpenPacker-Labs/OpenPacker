import { readFile } from 'node:fs/promises';
import {
  createEmbeddedResolver,
  loadEmbeddedResolver,
} from '@openpacker/embedded';
import * as bindings from '@openpacker/embedded/wasm-node';
import type {
  ResolutionUniverse,
  SignedReceipt,
  SolveRequest,
} from '@openpacker/contracts';
import { describe, expect, it } from 'vitest';
import { verifyEmbeddedBoundary } from '../src/index.js';

const root = new URL('../../../', import.meta.url);

describe('Epoch embedded resolver boundary', () => {
  it('preserves receipt and proof bytes through direct and async Node WASM bindings', async () => {
    const [request, universe, signedReceipt] = await Promise.all([
      readJson<SolveRequest>('fixtures/protocol/solve/request.json'),
      readJson<ResolutionUniverse>('fixtures/epoch/universe.json'),
      readJson<SignedReceipt>('fixtures/epoch/signed-receipt.json'),
    ]);
    const direct = await verifyEmbeddedBoundary({
      resolver: createEmbeddedResolver(bindings),
      request,
      universe,
      signedReceipt,
    });
    const loaded = await verifyEmbeddedBoundary({
      resolver: await loadEmbeddedResolver(async () => ({
        ...bindings,
        default: async () => undefined,
      })),
      request,
      universe,
      signedReceipt,
    });
    expect(loaded).toEqual(direct);
    expect(direct.proofBytes.byteLength).toBeGreaterThan(0);
    expect(direct.receiptBytes.byteLength).toBeGreaterThan(0);
  });
});

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(new URL(path, root), 'utf8')) as T;
}
