import {
  canonicalBytes,
  canonicalDigest,
  formatDigest,
} from '@openpacker/canonical';
import { randomUUID } from 'node:crypto';
import { validateContract } from '@openpacker/conformance';
import type {
  ArtifactDescriptor,
  ExternalRef,
  JsonValue,
  ResolutionUniverse,
  SignedReceipt,
  SolveRequest,
} from '@openpacker/contracts';
import type { EmbeddedResolver } from '@openpacker/embedded';
import {
  verifyCloudEvent,
  type OpenPackerCloudEvent,
} from '@openpacker/events';
import {
  canonicalRequestDigest,
  verifySignedReceipt,
} from '@openpacker/receipts';
import type { OpenPackerClient, RawEvent } from '@openpacker/sdk';
import type { Verifier } from '@openpacker/trust';

export interface EpochConsumerPort {
  appendOpenPackerEvent(input: {
    event: OpenPackerCloudEvent;
    canonicalEventBytes: Uint8Array;
    dataDigest: string;
  }): Promise<{ externalEventRef: string }>;

  persistOpenPackerReceipt(input: {
    receipt: SignedReceipt;
    canonicalReceiptBytes: Uint8Array;
    receiptDigest: string;
  }): Promise<{ externalArtifactRef: string }>;

  registerArtifactDescriptor(input: {
    descriptor: ArtifactDescriptor;
    solutionDigest: string;
  }): Promise<void>;

  loadOpenPackerEventCheckpoint(): Promise<number>;
  commitOpenPackerEventCheckpoint(checkpoint: number): Promise<void>;
}

export interface EpochOwnedEnvelope {
  openPackerDigest: string;
  externalRefs: ExternalRef[];
}

export function createEpochOwnedEnvelope(
  openPackerDigest: string,
  externalRefs: readonly ExternalRef[],
): EpochOwnedEnvelope {
  return { openPackerDigest, externalRefs: [...externalRefs] };
}

export async function verifyEmbeddedBoundary(input: {
  resolver: EmbeddedResolver;
  request: SolveRequest;
  universe: ResolutionUniverse;
  signedReceipt: SignedReceipt;
}): Promise<{
  proofBytes: Uint8Array;
  receiptBytes: Uint8Array;
  proofDigest: string;
  receiptDigest: string;
}> {
  const solveInput = { request: input.request, universe: input.universe };
  const output = input.resolver.solve(solveInput);
  const checked = input.resolver.check(solveInput, output);
  if (!checked.valid)
    throw new Error(
      `Embedded proof check failed: ${checked.diagnostics.join('; ')}`,
    );
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const proofBytes = canonicalBytes(
    JSON.parse(JSON.stringify(output.proof)) as JsonValue,
  );
  const embeddedProofBytes = new TextEncoder().encode(
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    input.resolver.canonicalize(
      JSON.parse(JSON.stringify(output.proof)) as JsonValue,
    ),
  );
  if (!equalBytes(proofBytes, embeddedProofBytes))
    throw new Error('Embedded proof canonical bytes differ from TypeScript');
  const receiptBytes = canonicalBytes(
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    JSON.parse(JSON.stringify(input.signedReceipt.receipt)) as JsonValue,
  );
  const receiptDigest = formatDigest(input.signedReceipt.receiptDigest);
  if (
    !input.resolver.verifyReceiptDigest(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      JSON.parse(JSON.stringify(input.signedReceipt.receipt)) as JsonValue,
      receiptDigest,
    )
  )
    throw new Error('Embedded receipt digest verification failed');
  const proofDigest = formatDigest(
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    input.resolver.digest(
      JSON.parse(JSON.stringify(output.proof)) as JsonValue,
    ),
  );
  if (
    proofDigest !==
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    formatDigest(
      await canonicalDigest(
        JSON.parse(JSON.stringify(output.proof)) as JsonValue,
      ),
    )
  )
    throw new Error('Embedded proof digest differs from TypeScript');
  return { proofBytes, receiptBytes, proofDigest, receiptDigest };
}

const SIGNED_RECEIPT_SCHEMA =
  'https://openpacker.dev/spec/prex/v1/schemas/resolution.schema.json#/$defs/SignedReceipt';

export async function consumeResolution(input: {
  client: Pick<OpenPackerClient, 'solve' | 'verify' | 'receipt'>;
  request: SolveRequest;
  port: EpochConsumerPort;
  receiptVerifiers: ReadonlyMap<string, Verifier>;
}): Promise<EpochOwnedEnvelope> {
  const idempotencyKey = input.request.context?.idempotencyKey ?? randomUUID();
  const solved = await input.client.solve({
    ...input.request,
    context: { ...input.request.context, idempotencyKey },
  });
  const signed = solved.data.signedReceipt;
  if (!signed)
    throw new Error('OpenPacker did not return the required signed receipt');
  assertSignedReceiptSchema(signed);
  await verifySignedReceipt(signed, input.receiptVerifiers);
  if (
    signed.receipt.normalizedRequest.context?.idempotencyKey !== idempotencyKey
  )
    throw new Error('Signed receipt does not bind the requested solve input');
  const requestDigest = formatDigest(
    await canonicalRequestDigest(solved.data.normalizedRequest),
  );
  if (
    formatDigest(solved.data.requestDigest) !== requestDigest ||
    formatDigest(signed.receipt.requestDigest) !== requestDigest ||
    formatDigest(signed.receipt.universeDigest) !==
      formatDigest(solved.data.universeDigest) ||
    formatDigest(signed.receipt.solutionDigest) !==
      formatDigest(solved.data.solution.solutionDigest) ||
    !equalBytes(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      canonicalBytes(JSON.parse(JSON.stringify(signed.receipt)) as JsonValue),
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      canonicalBytes(
        JSON.parse(JSON.stringify(solved.data.unsignedReceipt)) as JsonValue,
      ),
    )
  )
    throw new Error('Signed receipt does not bind the returned solve result');
  const verification = await input.client.verify({
    subject: signed,
    checks: ['prex-receipt-signature'],
    evaluationTime: input.request.evaluationTime,
  });
  if (verification.data.decision !== 'allow')
    throw new Error(
      `OpenPacker denied its signed receipt: ${verification.data.decision}`,
    );

  const receiptDigest = formatDigest(signed.receiptDigest);
  const fetched = await input.client.receipt(
    signed.receiptDigest.algorithm,
    signed.receiptDigest.value,
  );
  if (!('receipt' in fetched.data))
    throw new Error('Receipt route returned an unsigned document');
  assertSignedReceiptSchema(fetched.data);
  await verifySignedReceipt(fetched.data, input.receiptVerifiers);
  if (
    !equalBytes(
      fetched.rawBytes,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      canonicalBytes(JSON.parse(JSON.stringify(fetched.data)) as JsonValue),
    )
  )
    throw new Error("SDK receipt bytes are not the provider's canonical bytes");
  if (formatDigest(fetched.data.receiptDigest) !== receiptDigest)
    throw new Error('Receipt digest changed during SDK retrieval');
  const canonicalReceiptBytes = canonicalBytes(
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    JSON.parse(JSON.stringify(fetched.data.receipt)) as JsonValue,
  );
  if (
    formatDigest(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      await canonicalDigest(
        JSON.parse(JSON.stringify(fetched.data.receipt)) as JsonValue,
      ),
    ) !== receiptDigest
  )
    throw new Error('Canonical receipt bytes do not match receiptDigest');

  const persisted = await input.port.persistOpenPackerReceipt({
    receipt: fetched.data,
    canonicalReceiptBytes,
    receiptDigest,
  });
  const solutionDigest = formatDigest(solved.data.solution.solutionDigest);
  for (const selected of solved.data.selected) {
    for (const descriptor of selected.artifacts)
      await input.port.registerArtifactDescriptor({
        descriptor,
        solutionDigest,
      });
  }
  return {
    openPackerDigest: receiptDigest,
    externalRefs: [
      { type: 'epoch-artifact', locator: persisted.externalArtifactRef },
    ],
  };
}

export class EpochEventConsumer {
  readonly #seen = new Map<string, Uint8Array>();
  constructor(private readonly port: EpochConsumerPort) {}

  async consume(input: RawEvent): Promise<EpochOwnedEnvelope> {
    await verifyCloudEvent(input.event, input.rawBytes);
    const prior = this.#seen.get(input.event.id);
    if (prior) {
      if (!equalBytes(prior, input.rawBytes))
        throw new Error(
          `Event ID ${input.event.id} was reused with different bytes`,
        );
      return { openPackerDigest: input.event.datadigest, externalRefs: [] };
    }
    const appended = await this.port.appendOpenPackerEvent({
      event: input.event,
      canonicalEventBytes: input.rawBytes,
      dataDigest: input.event.datadigest,
    });
    this.#seen.set(input.event.id, Uint8Array.from(input.rawBytes));
    return {
      openPackerDigest: input.event.datadigest,
      externalRefs: [
        { type: 'epoch-event', locator: appended.externalEventRef },
      ],
    };
  }

  loadCheckpoint(): Promise<number> {
    return this.port.loadOpenPackerEventCheckpoint();
  }

  commitCheckpoint(checkpoint: number): Promise<void> {
    return this.port.commitOpenPackerEventCheckpoint(checkpoint);
  }
}

export async function consumeEvents(
  client: OpenPackerClient,
  consumer: EpochEventConsumer,
  cursor?: number,
  pageSize = 1_000,
): Promise<EpochOwnedEnvelope[]> {
  const result: EpochOwnedEnvelope[] = [];
  let checkpoint = cursor ?? (await consumer.loadCheckpoint());
  for (;;) {
    const page = await client.eventPage(checkpoint, pageSize);
    for (const event of page.events) result.push(await consumer.consume(event));
    await consumer.commitCheckpoint(page.nextCursor);
    if (page.events.length < pageSize || page.nextCursor <= checkpoint) break;
    checkpoint = page.nextCursor;
  }
  return result;
}

export class InMemoryEpochConsumerPort implements EpochConsumerPort {
  eventCheckpoint = 0;
  readonly events = new Map<
    string,
    { event: OpenPackerCloudEvent; bytes: Uint8Array }
  >();
  readonly receipts = new Map<
    string,
    { receipt: SignedReceipt; bytes: Uint8Array }
  >();
  readonly artifacts = new Map<
    string,
    { descriptor: ArtifactDescriptor; solutionDigest: string }
  >();

  async appendOpenPackerEvent(input: {
    event: OpenPackerCloudEvent;
    canonicalEventBytes: Uint8Array;
    dataDigest: string;
  }): Promise<{ externalEventRef: string }> {
    if (input.dataDigest !== input.event.datadigest)
      throw new Error('Event data digest changed at the consumer boundary');
    const prior = this.events.get(input.event.id);
    if (prior && !equalBytes(prior.bytes, input.canonicalEventBytes))
      throw new Error('Duplicate event ID carries different bytes');
    this.events.set(
      input.event.id,
      prior ?? {
        event: input.event,
        bytes: Uint8Array.from(input.canonicalEventBytes),
      },
    );
    return {
      externalEventRef: `urn:epoch:event:${encodeURIComponent(input.event.id)}`,
    };
  }

  async persistOpenPackerReceipt(input: {
    receipt: SignedReceipt;
    canonicalReceiptBytes: Uint8Array;
    receiptDigest: string;
  }): Promise<{ externalArtifactRef: string }> {
    if (
      formatDigest(
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        await canonicalDigest(
          JSON.parse(JSON.stringify(input.receipt.receipt)) as JsonValue,
        ),
      ) !== input.receiptDigest
    )
      throw new Error('Receipt bytes changed at the consumer boundary');
    if (
      !equalBytes(
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        canonicalBytes(
          JSON.parse(JSON.stringify(input.receipt.receipt)) as JsonValue,
        ),
        input.canonicalReceiptBytes,
      )
    )
      throw new Error('Receipt bytes are not canonical');
    const prior = this.receipts.get(input.receiptDigest);
    if (prior && !equalBytes(prior.bytes, input.canonicalReceiptBytes))
      throw new Error('Duplicate receipt digest carries different bytes');
    this.receipts.set(
      input.receiptDigest,
      prior ?? {
        receipt: input.receipt,
        bytes: Uint8Array.from(input.canonicalReceiptBytes),
      },
    );
    return { externalArtifactRef: `urn:epoch:blob:${input.receiptDigest}` };
  }

  async registerArtifactDescriptor(input: {
    descriptor: ArtifactDescriptor;
    solutionDigest: string;
  }): Promise<void> {
    const prior = this.artifacts.get(input.descriptor.descriptorId);
    if (
      prior &&
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      canonicalBytes(
        JSON.parse(JSON.stringify(prior.descriptor)) as JsonValue,
      ).toString() !==
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        canonicalBytes(
          JSON.parse(JSON.stringify(input.descriptor)) as JsonValue,
        ).toString()
    )
      throw new Error('Artifact descriptor ID carries different content');
    this.artifacts.set(input.descriptor.descriptorId, input);
  }

  async loadOpenPackerEventCheckpoint(): Promise<number> {
    return this.eventCheckpoint;
  }

  async commitOpenPackerEventCheckpoint(checkpoint: number): Promise<void> {
    if (!Number.isSafeInteger(checkpoint) || checkpoint < this.eventCheckpoint)
      throw new Error('Event checkpoint must advance monotonically');
    this.eventCheckpoint = checkpoint;
  }
}

function assertSignedReceiptSchema(
  value: unknown,
): asserts value is SignedReceipt {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const result = validateContract(SIGNED_RECEIPT_SCHEMA, value as JsonValue);
  if (!result.valid)
    throw new TypeError(
      `Invalid signed receipt: ${result.errors.map((error) => `${error.instancePath} ${error.message ?? 'invalid'}`).join('; ')}`,
    );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}
