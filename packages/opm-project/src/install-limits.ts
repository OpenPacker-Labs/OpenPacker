import { PACKAGE_TREE_LIMITS } from '@openpacker/adapter-core';
import {
  DEFAULT_MATERIALIZATION_LIMITS,
  type MaterializationLimits,
} from '@openpacker/materializer';
import { MAXIMUM_ARCHIVE_BYTES } from './frozen-fetch.js';

/**
 * Bounds a package archive is extracted under when `opm add` and `opm install`
 * put it in the store.
 *
 * The materializer's defaults (64 MiB, ten thousand files) suit a small tool,
 * not a dependency tree: the platform build of `@openai/codex` is 92 MB packed
 * and 233 MB unpacked, a native build of onnxruntime 287 MB unpacked. For an
 * npm package they are the bounds `opm ci` already extracts under
 * (`frozenArchiveLimits`), so a package one path accepts is not refused by the
 * other. Another ecosystem's archive keeps the materializer's defaults: `opm
 * ci` reads npm locks only, and nothing about the packages that were failing
 * is true of a crate or a wheel.
 *
 * npm's own extractor reads `package/./dist/index.js` as `package/dist/index.js`
 * (agent-base@7.1.4 is published that way), and an npm lock says so when it is
 * frozen; the same package added by `opm add` is read the same way.
 */
export function installArchiveLimits(
  ecosystem?: string,
): MaterializationLimits {
  if (ecosystem !== 'npm') return { ...DEFAULT_MATERIALIZATION_LIMITS };
  return {
    ...DEFAULT_MATERIALIZATION_LIMITS,
    ...PACKAGE_TREE_LIMITS,
    maximumExpandedBytes: 1024 * 1024 * 1024,
    maximumCompressedBytes: MAXIMUM_ARCHIVE_BYTES,
    maximumCompressionRatio: 128,
    maximumMemoryBytes: 3 * 1024 * 1024 * 1024,
    acceptRedundantEntries: true,
  };
}
