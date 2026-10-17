// Run in a child process by held-packument.test.ts:
//   node --expose-gc held-packument-child.mjs <repository root>
// Asks the real npm provider for a publish time that needs the full packument, over a transport whose budget keeps
// nothing, and measures the heap while the full document is on its way: what is still held of the abbreviated one.
import { pathToFileURL } from 'node:url';

const [root] = process.argv.slice(2);
const load = (path) => import(pathToFileURL(`${root}/${path}`).href);
const { NpmRegistryProvider } = await load('packages/adapter-npm/dist/esm/index.js');
const { RetentionLedger } = await load('packages/adapter-core/dist/esm/index.js');

// 600,000 objects of one member: about 110 MiB of tree for 9 MiB of text.
const abbreviated = Buffer.from(
  JSON.stringify({
    name: 'held',
    'dist-tags': { latest: '1.0.0' },
    versions: { '1.0.0': { name: 'held', version: '1.0.0' } },
    x: Array.from({ length: 600_000 }, (_, index) => ({ a: index })),
  }),
);
const full = Buffer.from(
  JSON.stringify({ time: { '1.0.0': '2020-01-01T00:00:00.000Z' } }),
);
let release;
const gate = new Promise((resolve) => (release = resolve));
let asked;
const askedForFull = new Promise((resolve) => (asked = resolve));
const transport = {
  refetchable: true,
  retention: new RetentionLedger(0),
  async request(request) {
    if (request.headers?.accept === 'application/json') {
      asked();
      await gate;
      return { status: 200, headers: {}, body: full, url: request.url };
    }
    return { status: 200, headers: {}, body: abbreviated, url: request.url };
  },
};
const provider = new NpmRegistryProvider(transport, {
  now: () => '2026-10-17T00:00:00Z',
});
globalThis.gc();
const before = process.memoryUsage().heapUsed;
const pending = provider.publishTime('pkg:npm/held@1.0.0');
await askedForFull;
globalThis.gc();
globalThis.gc();
const heldMiB = (process.memoryUsage().heapUsed - before) / 2 ** 20;
release();
const evidence = await pending;
process.stdout.write(`${JSON.stringify({ heldMiB: Math.round(heldMiB), evidence })}\n`);
