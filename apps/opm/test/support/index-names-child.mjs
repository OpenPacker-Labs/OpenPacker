// Run in a child process by index-names.test.ts:
//   node --max-old-space-size=1024 index-names-child.mjs <repository root> <piece> <abbreviated|full>
// Parses a packument of exactly the byte bound whose `x` member is an array of `piece`, an object whose members are
// named by array indices, under the cost limit that document is read under, and says whether it was refused.
import { pathToFileURL } from 'node:url';

const [root, name, document] = process.argv.slice(2);
const load = (path) => import(pathToFileURL(`${root}/${path}`).href);
const { json } = await load('packages/adapter-core/dist/esm/index.js');
const npm = await load('packages/adapter-npm/dist/esm/index.js');

const PIECES = {
  // V8 gives each a fast elements store of 3,880 slots: 31,240 bytes for 20 bytes of text.
  idx2: () => '{"1023":0,"2575":0}',
  // 1,552 slots for one member.
  idx1: () => '{"1023":0}',
  // Three members, the store grown twice, 3,916 slots.
  idx3: () => '{"0":0,"1040":0,"2600":0}',
};
const full = document === 'full';
const bound = full
  ? npm.MAXIMUM_FULL_PACKUMENT_BYTES
  : npm.MAXIMUM_PACKUMENT_BYTES;
const limits = full ? npm.FULL_PACKUMENT_LIMITS : npm.PACKUMENT_LIMITS;
const piece = PIECES[name]();
const head =
  '{"name":"hostile","dist-tags":{"latest":"1.0.0"},"versions":{},"x":[';
const count = Math.floor((bound - head.length - 2) / (piece.length + 1));
const text = `${head}${Array(count).fill(piece).join(',')}]}`;
const body = Buffer.alloc(bound, 0x20);
body.write(text);
try {
  json(
    {
      status: 200,
      headers: {},
      body,
      url: 'https://registry.npmjs.org/hostile',
    },
    limits,
  );
  process.stdout.write(`accepted ${count} objects\n`);
} catch (error) {
  process.stdout.write(`refused: ${error.message}\n`);
  process.exitCode = 3;
}
