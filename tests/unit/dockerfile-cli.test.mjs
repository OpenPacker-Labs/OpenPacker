import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const dockerfile = readFileSync(
  join(root, 'apps/openpacker-cli/Dockerfile'),
  'utf8',
);

test('CLI runtime Dockerfile is multi-stage, digest-pinned, and non-root', () => {
  assert.match(dockerfile, /^# syntax=docker\/dockerfile/m);
  assert.match(dockerfile, /FROM \$\{NODE_BUILD_IMAGE\} AS build/u);
  assert.match(dockerfile, /FROM \$\{NODE_RUNTIME_IMAGE\} AS runtime/u);
  assert.match(dockerfile, /sha256:[a-f0-9]{64}/u);
  assert.match(dockerfile, /USER 65532:65532/u);
  assert.match(dockerfile, /ENTRYPOINT \["node", "dist\/index.js"\]/u);
});
