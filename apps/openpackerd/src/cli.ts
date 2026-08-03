#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import type { PrexOperations } from './operations.js';
import { startOpenPackerDaemon } from './index.js';
import { createStandaloneReferenceOperations } from './reference.js';

const modulePath = process.env.OPENPACKER_OPERATIONS_MODULE;
let operations: PrexOperations;
if (modulePath) {
  const loaded = (await import(pathToFileURL(modulePath).href)) as {
    default?: PrexOperations;
    operations?: PrexOperations;
  };
  const configured = loaded.operations ?? loaded.default;
  if (!configured)
    throw new Error(
      'The operations module must export `operations` or a default PrexOperations object',
    );
  operations = configured;
} else {
  operations = await createStandaloneReferenceOperations(
    process.env.OPENPACKER_UNIVERSE,
  );
}

const server = await startOpenPackerDaemon({
  operations,
  databasePath:
    process.env.OPENPACKER_DATABASE ?? '.openpacker/openpackerd.sqlite',
  host: process.env.OPENPACKER_HOST ?? '127.0.0.1',
  port: Number(process.env.OPENPACKER_PORT ?? '7337'),
  logger: true,
});
process.stdout.write(`${server.address}\n`);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => void server.close());
