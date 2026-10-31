// Run in a child process by hostile-packument.test.ts:
//   node --max-old-space-size=1024 hostile-packument-child.mjs <repository root> [members|empties|worst-accepted]
// Resolves one package whose packument is a hostile document of exactly the size of the bound (64 MiB), through the
// real provider, memo and parser, with the registry transport injected, and reports as the CLI does: the exit code and
// the line `handleError` writes. Run against another checkout's build by naming its root.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, kind = 'members'] = process.argv.slice(2);
const load = (path) => import(pathToFileURL(`${root}/${path}`).href);
const { handleError } = await load('apps/opm/dist/opm.js');
const { resolveManifestToLock, defaultSupplyChainPolicyInput } = await load(
  'packages/opm-project/dist/esm/index.js',
);
const { configureDefaultAdapters } = await load(
  'packages/adapters-default/dist/esm/index.js',
);
configureDefaultAdapters();

const BOUND = 64 * 1024 * 1024;
const pad = (index, width) => String(index).padStart(width, '0');

/** A packument of exactly `size` bytes whose `x` member is `piece(index)` repeated, then spaces. */
function document(size, open, close, piece, last) {
  const prefix = `{"name":"hostile","dist-tags":{"latest":"1.0.0"},"versions":{},"x":${open}`;
  const suffix = `${close}}`;
  const chunks = [Buffer.from(prefix)];
  let written = prefix.length;
  let batch = [];
  let batchBytes = 0;
  const limit = size - suffix.length - last.length;
  for (let index = 0; ; index += 1) {
    const text = piece(index);
    if (written + batchBytes + text.length > limit) break;
    batch.push(text);
    batchBytes += text.length;
    if (batchBytes > 1 << 20) {
      chunks.push(Buffer.from(batch.join('')));
      written += batchBytes;
      batch = [];
      batchBytes = 0;
    }
  }
  chunks.push(Buffer.from(batch.join('') + last));
  written += batchBytes + last.length;
  chunks.push(
    Buffer.alloc(size - written - suffix.length, 0x20),
    Buffer.from(suffix),
  );
  return Buffer.concat(chunks);
}

/**
 * A document of 14-character strings that costs 0.95 of the limit the packument is read under, the heaviest
 * accepted kind found: it is the one that held the most memory of the kinds the limit lets through.
 */
async function worstAccepted() {
  const { PARSE_COSTS } = await load('packages/canonical/dist/esm/index.js');
  const { PACKUMENT_PARSE_COST } = await load(
    'packages/adapter-npm/dist/esm/index.js',
  );
  const { peak } = PARSE_COSTS;
  const each = peak.element + peak.string + 14 * peak.character;
  const count = Math.floor((0.95 * PACKUMENT_PARSE_COST) / each);
  if (!(count > 1_000_000))
    throw new Error(`the document would hold ${count} strings`);
  const head =
    '{"name":"hostile","dist-tags":{"latest":"1.0.0"},"versions":{},"x":[';
  const strings = Array.from(
    { length: count },
    (_, index) => `"${pad(index, 14)}"`,
  );
  return Buffer.from(`${head}${strings.join(',')}]}`);
}

const DOCUMENTS = {
  // One object of 3.7 million members, each an empty object: 18 bytes a member, 4,194,304 values at most.
  members: () =>
    document(BOUND, '{', '}', (index) => `"${pad(index, 12)}":{},`, '"x":{}'),
  // 22 million empty objects in an array, 3 bytes a value.
  empties: () => document(BOUND, '[', ']', () => '{},', '{}'),
};
const body =
  kind === 'worst-accepted' ? await worstAccepted() : DOCUMENTS[kind]();
if (kind !== 'worst-accepted' && body.length !== BOUND)
  throw new Error(`the document is ${body.length} bytes`);

const transport = {
  async request(request) {
    return { status: 200, headers: {}, body, url: request.url };
  },
};

const root_ = await mkdtemp(join(tmpdir(), 'opm-hostile-'));
try {
  const lock = await resolveManifestToLock({
    root: root_,
    manifest: {
      project: { name: 'hostile', ecosystems: ['npm'] },
      packages: {
        hostile: {
          alias: 'hostile',
          purl: 'pkg:npm/hostile',
          version: '1.0.0',
        },
      },
      options: { offline: false, layout: 'opm' },
      policy: defaultSupplyChainPolicyInput(),
    },
    offline: false,
    registryOptions: { transport },
  });
  process.stdout.write(`locked ${Object.keys(lock.packages).length}\n`);
} catch (error) {
  process.exitCode = handleError(error, process);
} finally {
  await rm(root_, { recursive: true, force: true });
}
