/**
 * Child process for store-lease.test.ts: hold a lease until SIGKILL.
 * Run with vite-node from the opm-project package root.
 */
import { openLease, leaseDirectory } from '../../src/store-lease.js';

const [store, kind, line] = process.argv.slice(2) as [
  string,
  'install' | 'gc',
  string,
];
if (store === undefined || kind === undefined || line === undefined) {
  throw new Error('usage: store-lease-holder.ts <store> <install|gc> <line>');
}

const lease = await openLease(leaseDirectory(store), kind);
await lease.write(line);
process.stdout.write('held\n');
setInterval(() => {}, 1 << 30);
