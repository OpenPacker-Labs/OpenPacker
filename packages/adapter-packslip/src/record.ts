import { echoed } from '@openpacker/adapter-core';
import type { JsonValue } from '@openpacker/contracts';
import {
  ObjectReader,
  PackslipError,
  type ListMemory,
  type ResolvedRelease,
  type SignerRecord,
  type TrustMemory,
} from '@openpacker/packslip';
import type { JsonObject } from '@openpacker/packslip';

/**
 * What the lock keeps about a packslip release, so the next resolution can tell
 * that its signer changed. Everything in it is derived from the signed bundle,
 * which is what lets an online `opm install` re-resolve a package and find the
 * lock unchanged.
 */
export interface PriorAttestation {
  readonly memory: TrustMemory;
  readonly list: ListMemory;
}

export function encodeRecord(resolved: ResolvedRelease): JsonObject {
  const { memory } = resolved;
  const signer: JsonObject = {
    scheme: memory.signer.scheme,
    identity: memory.signer.identity,
    pin_workflow: memory.signer.pinWorkflow,
  };
  if (memory.signer.issuer !== undefined) signer.issuer = memory.signer.issuer;
  if (memory.signer.repositoryId !== undefined)
    signer.repository_id = memory.signer.repositoryId;
  if (memory.signer.keyHint !== undefined)
    signer.key_hint = memory.signer.keyHint;
  if (resolved.verified.signer.fingerprint !== undefined)
    signer.fingerprint = resolved.verified.signer.fingerprint;
  const record: JsonObject = {
    project: memory.project,
    version: resolved.statement.version,
    bundle_digest: resolved.verified.bundleDigest,
    artifact: resolved.artifact.name,
    attested_by: memory.attestedBy,
    logged: memory.logged,
    provenance: memory.provenance,
    signer,
  };
  if (resolved.candidate.tag !== undefined) record.tag = resolved.candidate.tag;
  if (resolved.verified.integratedTime !== undefined)
    record.integrated_time = resolved.verified.integratedTime;
  if (resolved.list !== undefined)
    record.list = { sequence: resolved.list.sequence };
  return record;
}

function fail(message: string): PackslipError {
  return new PackslipError('INVALID_INPUT', `lock attestation: ${message}`);
}

/**
 * Read back what an earlier resolution kept. A record that does not decode is
 * an error, not an absence: treating a damaged record as "never seen" would let
 * corrupting the lock switch continuity checks off.
 */
export function decodeRecord(value: JsonValue): PriorAttestation {
  try {
    return decode(value);
  } catch (error) {
    if (error instanceof PackslipError)
      throw new PackslipError(
        'INVALID_INPUT',
        error.message.startsWith('lock attestation')
          ? error.message
          : `lock attestation: ${error.message}`,
      );
    throw error;
  }
}

function decode(value: JsonValue): PriorAttestation {
  const root = new ObjectReader(value, 'attestation', 'INVALID_INPUT');
  const signerReader = root.object('signer');
  const scheme = signerReader.string('scheme');
  if (scheme !== 'sigstore-oidc' && scheme !== 'sigstore-key')
    throw fail(`unknown signature scheme "${echoed(scheme)}"`);
  const attestedBy = root.string('attested_by');
  if (attestedBy !== 'vendor' && attestedBy !== 'repackager')
    throw fail(`unknown attestation "${echoed(attestedBy)}"`);
  const issuer = signerReader.optionalString('issuer');
  const repositoryId = signerReader.optionalString('repository_id');
  const keyHint = signerReader.optionalString('key_hint');
  const signer: SignerRecord = {
    scheme,
    identity: signerReader.string('identity'),
    pinWorkflow: signerReader.optionalBoolean('pin_workflow') ?? true,
    ...(issuer !== undefined && { issuer }),
    ...(repositoryId !== undefined && { repositoryId }),
    ...(keyHint !== undefined && { keyHint }),
  };
  const list = root.optionalObject('list');
  return {
    memory: {
      project: root.string('project'),
      signer,
      attestedBy,
      logged: root.optionalBoolean('logged') ?? false,
      provenance: root.optionalBoolean('provenance') ?? false,
    },
    list:
      list === undefined
        ? {}
        : { used: true, sequence: list.integer('sequence') },
  };
}
