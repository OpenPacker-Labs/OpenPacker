import { readFile } from 'node:fs/promises';
import { createOpenPackerClient } from '@openpacker/sdk';
import { Ed25519Verifier } from '@openpacker/trust';
import type { SolveRequest } from '@openpacker/contracts';
import {
  consumeEvents,
  consumeResolution,
  EpochEventConsumer,
  InMemoryEpochConsumerPort,
} from './index.js';

const root = new URL('../../../', import.meta.url);
const request = JSON.parse(
  await readFile(new URL('fixtures/protocol/solve/request.json', root), 'utf8'),
) as SolveRequest;
const keys = JSON.parse(
  await readFile(new URL('fixtures/trust/keys.json', root), 'utf8'),
) as { root: JsonWebKey };
const verifier = await Ed25519Verifier.fromJwk('root', keys.root);
const client = createOpenPackerClient({
  baseUrl: process.env.OPENPACKER_URL ?? 'http://127.0.0.1:7337',
});
const port = new InMemoryEpochConsumerPort();
const receipt = await consumeResolution({
  client,
  request,
  port,
  receiptVerifiers: new Map([['root', verifier]]),
});
const events = await consumeEvents(client, new EpochEventConsumer(port));
process.stdout.write(
  `${JSON.stringify({ receipt, events, persistedReceipts: port.receipts.size, persistedEvents: port.events.size })}\n`,
);
