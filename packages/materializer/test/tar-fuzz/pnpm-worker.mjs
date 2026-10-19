/**
 * pnpm's `parseTarball` in a worker thread of its own: given an x header whose
 * declared size runs past the data, it spins for minutes (found by the fuzz),
 * so run.mjs gives each archive a deadline and replaces a worker that misses it.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { loadParseTarball, pnpm } from '../tar-oracle/readers.mjs';

const parseTarball = loadParseTarball(workerData.pnpmDirectory);
parentPort.on('message', ({ id, bytes }) => {
  parentPort.postMessage({
    id,
    result: pnpm(parseTarball, Buffer.from(bytes)),
  });
});
