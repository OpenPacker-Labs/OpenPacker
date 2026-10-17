import type { EmbeddedResolver } from '@openpacker/embedded';
import { OpmError } from './types.js';

/**
 * Load the PREX solver for Node.
 *
 * Through the package's `wasm-node` entry, which wasm-bindgen builds for the
 * nodejs target and which reads the module with `readFileSync`. The generic
 * loader hands wasm-bindgen a relative URL instead and resolves it with
 * `fetch`, and Node's fetch has no `file:` scheme — so that path throws "not
 * implemented" rather than loading anything.
 *
 * A checkout that could not build the wasm target (no `wasm32` toolchain, no
 * `wasm-bindgen`) still builds the Node-API addon from the same crate, so the
 * solver falls back to `@openpacker/embedded/native` rather than returning no
 * closure at all. Both are the same engine; `tests/compat/native-node.test.mjs`
 * holds them to the same answers.
 */
export async function loadResolver(
  importers: {
    wasm?: () => Promise<Record<string, unknown>>;
    native?: () => Promise<EmbeddedResolver>;
  } = {},
): Promise<EmbeddedResolver> {
  const embedded = await import('@openpacker/embedded');
  const wasm =
    importers.wasm ??
    (async () => {
      const specifier = '@openpacker/embedded/wasm-node';
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      return (await import(specifier)) as Record<string, unknown>;
    });
  try {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    return embedded.createEmbeddedResolver((await wasm()) as never);
  } catch (wasmError) {
    if (!isMissingModule(wasmError)) throw wasmError;
    try {
      return await (importers.native ?? loadNativeResolver)();
    } catch (nativeError) {
      if (!isMissingModule(nativeError)) throw nativeError;
      throw new OpmError(
        'UNRESOLVABLE',
        'The PREX solver is not built: neither @openpacker/embedded/wasm-node ' +
          '(npm run build:wasm -w @openpacker/embedded) nor the Node-API addon ' +
          '(npm run build:native -w @openpacker/embedded) is present',
      );
    }
  }
}

async function loadNativeResolver(): Promise<EmbeddedResolver> {
  const specifier = '@openpacker/embedded/native';
  const native = (await import(specifier)) as {
    loadNativeEmbeddedResolver: () => Promise<EmbeddedResolver>;
  };
  return native.loadNativeEmbeddedResolver();
}

/** A module the build never produced, as opposed to one that failed to load. */
function isMissingModule(error: unknown): boolean {
  // SAFETY: only the optional `code` and `message` of a thrown value are read.
  const thrown = error as { code?: unknown; message?: unknown } | null;
  return (
    thrown?.code === 'ERR_MODULE_NOT_FOUND' ||
    thrown?.code === 'MODULE_NOT_FOUND' ||
    // Test runners re-wrap a missing file without keeping Node's code.
    (typeof thrown?.message === 'string' &&
      /Cannot find (?:module|package)|Failed to load url/u.test(thrown.message))
  );
}
