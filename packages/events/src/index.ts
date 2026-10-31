import {
  canonicalBytes,
  canonicalDigest,
  documentParseLimits,
  formatDigest,
  parseCanonicalJson,
} from '@openpacker/canonical';
import { createPrexValidator, validateContract } from '@openpacker/conformance';
import type {
  ArtifactDescriptor,
  Digest,
  EventData,
  EventType,
  ExternalRef,
  JsonValue,
  LifecycleEvent,
  OpenPackerCloudEvent,
  PackageInstance,
  SourceSnapshot,
} from '@openpacker/contracts';

export type {
  EventData,
  EventType,
  OpenPackerCloudEvent,
} from '@openpacker/contracts';

export const EVENT_DATA_SCHEMA =
  'https://openpacker.dev/spec/prex/v1/events/data.schema.json';
const EVENT_CONTRACT =
  'https://openpacker.dev/spec/prex/v1/schemas/events.schema.json#/$defs/OpenPackerCloudEvent';
export const EVENT_OCCURRENCE_ID_EXTENSION = 'org.openpacker.occurrenceid';
const eventValidator = createPrexValidator();

export const EVENT_TYPES = [
  'org.openpacker.catalog.snapshot.created',
  'org.openpacker.catalog.package.observed',
  'org.openpacker.lifecycle.changed',
  'org.openpacker.resolution.completed',
  'org.openpacker.resolution.unsatisfiable',
  'org.openpacker.receipt.created',
  'org.openpacker.artifact.packed',
  'org.openpacker.artifact.verified',
  'org.openpacker.policy.evaluated',
] as const satisfies readonly EventType[];

export interface Clock {
  now(): string;
}

export interface EventDataByType {
  'org.openpacker.catalog.snapshot.created': {
    schemaVersion: '1';
    snapshot: SourceSnapshot;
  };
  'org.openpacker.catalog.package.observed': {
    schemaVersion: '1';
    package: PackageInstance;
  };
  'org.openpacker.lifecycle.changed': {
    schemaVersion: '1';
    lifecycleEvent: LifecycleEvent;
  };
  'org.openpacker.resolution.completed': {
    schemaVersion: '1';
    solutionDigest: Digest;
    requestDigest: Digest;
    universeDigest: Digest;
  };
  'org.openpacker.resolution.unsatisfiable': {
    schemaVersion: '1';
    requestDigest: Digest;
    universeDigest: Digest;
    explanationDigest: Digest;
  };
  'org.openpacker.receipt.created': {
    schemaVersion: '1';
    receiptDigest: Digest;
  };
  'org.openpacker.artifact.packed': {
    schemaVersion: '1';
    descriptor: ArtifactDescriptor;
  };
  'org.openpacker.artifact.verified': {
    schemaVersion: '1';
    descriptor: ArtifactDescriptor;
  };
  'org.openpacker.policy.evaluated': {
    schemaVersion: '1';
    subjectDigest: Digest;
    decision: 'allow' | 'deny' | 'indeterminate';
  };
}

export interface CreateCloudEventInput<T extends EventType> {
  type: T;
  source: string;
  subject: string;
  data: EventDataByType[T];
  correlationId: string;
  causationId?: string;
  externalRefs?: ExternalRef[];
  extensions?: OpenPackerCloudEvent['extensions'];
  occurrenceId?: string;
  clock: Clock;
}

export type OpenPackerEventByType<T extends EventType> = Extract<
  OpenPackerCloudEvent,
  { type: T }
>;

const MUTABLE_OBSERVATIONS = new Set<EventType>([
  'org.openpacker.catalog.package.observed',
  'org.openpacker.lifecycle.changed',
  'org.openpacker.policy.evaluated',
]);

export async function createCloudEvent<T extends EventType>(
  input: CreateCloudEventInput<T>,
): Promise<OpenPackerEventByType<T>> {
  if (!input.source || !input.subject || !input.correlationId)
    throw new TypeError(
      'Event source, subject, and correlation ID are required',
    );
  if (MUTABLE_OBSERVATIONS.has(input.type) && !input.occurrenceId)
    throw new TypeError(`${input.type} requires a deterministic occurrence ID`);
  if (input.occurrenceId !== undefined && input.occurrenceId.length > 255)
    throw new TypeError('Event occurrence ID is limited to 255 characters');
  if (
    input.occurrenceId !== undefined &&
    input.extensions?.[EVENT_OCCURRENCE_ID_EXTENSION] !== undefined
  )
    throw new TypeError('Event occurrence ID extension is reserved');
  const time = input.clock.now();
  if (!Number.isFinite(Date.parse(time)))
    throw new TypeError('Clock must return an RFC 3339 timestamp');
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const data = JSON.parse(JSON.stringify(input.data)) as JsonValue;
  const datadigest = formatDigest(await canonicalDigest(data));
  const extensions = {
    ...input.extensions,
    ...(!(input.occurrenceId === undefined) && {
      [EVENT_OCCURRENCE_ID_EXTENSION]: input.occurrenceId,
    }),
  };
  const identity = eventIdentity(
    input.type,
    input.source,
    input.subject,
    datadigest,
    input.occurrenceId,
  );
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const event = {
    specversion: '1.0',
    id: formatDigest(await canonicalDigest(identity)),
    source: input.source,
    type: input.type,
    subject: input.subject,
    time,
    datacontenttype: 'application/json',
    dataschema: `${EVENT_DATA_SCHEMA}#/$defs/${input.type}`,
    datadigest,
    correlationid: input.correlationId,
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    data: data as EventData,
    externalrefs: input.externalRefs ?? [],
  } as unknown as OpenPackerEventByType<T>;
  if (input.causationId !== undefined) event.causationid = input.causationId;
  if (Object.keys(extensions).length !== 0) event.extensions = extensions;
  await verifyCloudEvent(event);
  return event;
}

export function canonicalEventBytes(event: OpenPackerCloudEvent): Uint8Array {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  return canonicalBytes(JSON.parse(JSON.stringify(event)) as JsonValue);
}

export async function verifyCloudEvent(
  event: OpenPackerCloudEvent,
  exactBytes?: Uint8Array,
): Promise<void> {
  const contract = validateContract(
    EVENT_CONTRACT,
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    JSON.parse(JSON.stringify(event)) as JsonValue,
    eventValidator,
  );
  if (!contract.valid)
    throw new TypeError(
      `Event contract violation: ${contract.errors
        .map(
          (error) =>
            `${error.instancePath || '/'} ${error.message ?? 'invalid'}`,
        )
        .join('; ')}`,
    );
  const digest = formatDigest(
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    await canonicalDigest(JSON.parse(JSON.stringify(event.data)) as JsonValue),
  );
  if (event.datadigest !== digest)
    throw new TypeError('Event data digest mismatch');
  const occurrenceId = event.extensions?.[EVENT_OCCURRENCE_ID_EXTENSION];
  if (
    occurrenceId !== undefined &&
    (typeof occurrenceId !== 'string' || occurrenceId.length === 0)
  )
    throw new TypeError('Event occurrence ID must be a non-empty string');
  if (MUTABLE_OBSERVATIONS.has(event.type) && occurrenceId === undefined)
    throw new TypeError(`${event.type} requires a deterministic occurrence ID`);
  const expectedId = formatDigest(
    await canonicalDigest(
      eventIdentity(
        event.type,
        event.source,
        event.subject,
        event.datadigest,
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        occurrenceId as string | undefined,
      ),
    ),
  );
  if (event.id !== expectedId)
    throw new TypeError('Event ID does not match its deterministic identity');
  if (exactBytes && !equalBytes(exactBytes, canonicalEventBytes(event)))
    throw new TypeError('Event bytes are not the canonical event bytes');
}

/**
 * Decode an event a caller received. Its parse may cost as much as an honest
 * document of its size (`documentParseLimits`, sixteen times its bytes), so
 * bytes that would cost more to hold (`{"1023":0}` costs thousands of times its
 * length) are refused before they are built (ADR 0044, "Documents other than
 * packuments").
 */
export async function decodeCloudEvent(
  bytes: Uint8Array,
): Promise<OpenPackerCloudEvent> {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const event = parseCanonicalJson(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    documentParseLimits(bytes.byteLength),
  ) as OpenPackerCloudEvent;
  await verifyCloudEvent(event, bytes);
  return event;
}

export interface PublishedEvent {
  event: OpenPackerCloudEvent;
  canonicalBytes: Uint8Array;
}
export interface EventPublishResult {
  eventId: string;
  checkpoint: string;
  duplicate: boolean;
}
export interface EventRecord extends PublishedEvent {
  checkpoint: string;
}

export interface EventSink {
  publish(
    input: PublishedEvent,
    signal?: AbortSignal,
  ): Promise<EventPublishResult>;
}

export class MemoryEventSink implements EventSink {
  readonly #records: EventRecord[] = [];
  readonly #checkpoints = new Map<string, string>();
  #nextCheckpoint = 1;
  constructor(private readonly maximumRecords = 10_000) {
    if (!Number.isSafeInteger(maximumRecords) || maximumRecords < 1)
      throw new RangeError('maximumRecords must be a positive safe integer');
  }

  async publish(
    input: PublishedEvent,
    signal?: AbortSignal,
  ): Promise<EventPublishResult> {
    if (signal?.aborted)
      throw (
        signal.reason ?? new DOMException('Operation aborted', 'AbortError')
      );
    await verifyCloudEvent(input.event, input.canonicalBytes);
    const prior = this.#checkpoints.get(input.event.id);
    if (prior)
      return { eventId: input.event.id, checkpoint: prior, duplicate: true };
    if (!Number.isSafeInteger(this.#nextCheckpoint))
      throw new RangeError('Event checkpoint exceeds the safe integer range');
    const checkpoint = String(this.#nextCheckpoint++);
    this.#records.push({
      event: input.event,
      canonicalBytes: Uint8Array.from(input.canonicalBytes),
      checkpoint,
    });
    this.#checkpoints.set(input.event.id, checkpoint);
    while (this.#records.length > this.maximumRecords) {
      this.#records.shift();
    }
    return { eventId: input.event.id, checkpoint, duplicate: false };
  }

  replay(
    afterCheckpoint = '0',
    limit = this.maximumRecords,
  ): readonly EventRecord[] {
    const cursor = parseCheckpoint(afterCheckpoint);
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError('limit must be a positive safe integer');
    return this.#records
      .filter((record) => Number(record.checkpoint) > cursor)
      .slice(0, limit);
  }
}

function eventIdentity(
  type: EventType,
  source: string,
  subject: string,
  datadigest: string,
  occurrenceId?: string,
): JsonValue {
  return {
    type,
    source,
    subject,
    datadigest,
    ...(!(occurrenceId === undefined) && { occurrenceid: occurrenceId }),
  };
}

function parseCheckpoint(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value))
    throw new TypeError('Checkpoint must be an unsigned decimal integer');
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new RangeError('Checkpoint exceeds the safe integer range');
  return result;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}
