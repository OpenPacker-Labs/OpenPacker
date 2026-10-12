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
 * and 233 MB unpacked, a native build of onnxruntime 287 MB unpacked. They are
 * the bounds `opm ci` already extracts under (`frozenArchiveLimits`), so a
 * package one path accepts is not refused by the other.
 *
 * npm's own extractor reads `package/./dist/index.js` as `package/dist/index.js`
 * (agent-base@7.1.4 is published that way), and an npm lock says so when it is
 * frozen; the same package added by `opm add` is read the same way.
 */
export function installArchiveLimits(
  ecosystem?: string,
): MaterializationLimits {
  return {
    ...DEFAULT_MATERIALIZATION_LIMITS,
    maximumFiles: 100_000,
    maximumExpandedBytes: 1024 * 1024 * 1024,
    maximumCompressedBytes: MAXIMUM_ARCHIVE_BYTES,
    maximumCompressionRatio: 128,
    maximumMemoryBytes: 3 * 1024 * 1024 * 1024,
    ...(ecosystem === 'npm' && { acceptRedundantEntries: true }),
  };
}
