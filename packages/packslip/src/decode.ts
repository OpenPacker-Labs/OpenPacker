import type { JsonValue } from '@openpacker/contracts';
import { ObjectReader } from './json.js';
import type { Evidence, Identity, SignatureScheme, Subject } from './types.js';
import { STATEMENT_TYPE } from './types.js';
import { shown } from './shown.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const SHA512 = /^[0-9a-f]{128}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
/** Vocabulary tokens are lowercase letters, digits, `_`, `-`, `.`. */
export const TOKEN = /^[a-z0-9][a-z0-9_.-]*$/u;

export function timestamp(reader: ObjectReader, key: string): string {
  const value = reader.string(key);
  if (!TIMESTAMP.test(value) || Number.isNaN(Date.parse(value)))
    throw reader.fail(
      `${reader.path}.${key}`,
      'must be an RFC 3339 UTC timestamp',
    );
  return value;
}

export function token(reader: ObjectReader, key: string): string | undefined {
  const value = reader.optionalString(key);
  if (value !== undefined && !TOKEN.test(value))
    throw reader.fail(
      `${reader.path}.${key}`,
      'must be a lowercase token of letters, digits, "_", "-" and "."',
    );
  return value;
}

/** The fixed in-toto framing every packslip statement shares. */
export function assertStatementFrame(
  root: ObjectReader,
  predicateType: string,
): void {
  if (root.string('_type') !== STATEMENT_TYPE)
    throw root.fail('_type', `must be ${STATEMENT_TYPE}`);
  if (root.string('predicateType') !== predicateType)
    throw root.fail('predicateType', `must be ${predicateType}`);
}

export function decodeSubjects(root: ObjectReader): Subject[] {
  const values = root.array('subject');
  const seen = new Set<string>();
  return values.map((_, index) => {
    const reader = root.element('subject', index, values);
    const name = reader.string('name');
    if (seen.has(name))
      throw reader.fail(
        `${reader.path}.name`,
        `"${shown(name)}" appears twice`,
      );
    seen.add(name);
    const digest = reader.object('digest');
    const sha256 = digest.string('sha256');
    if (!SHA256.test(sha256))
      throw digest.fail(
        `${digest.path}.sha256`,
        'must be 64 lowercase hexadecimal characters',
      );
    const sha512 = digest.optionalString('sha512');
    if (sha512 !== undefined && !SHA512.test(sha512))
      throw digest.fail(
        `${digest.path}.sha512`,
        'must be 128 lowercase hexadecimal characters',
      );
    return { name, sha256, ...(sha512 !== undefined && { sha512 }) };
  });
}

function scheme(reader: ObjectReader): SignatureScheme {
  const value = reader.string('scheme');
  if (value !== 'sigstore-oidc' && value !== 'sigstore-key')
    throw reader.fail(
      `${reader.path}.scheme`,
      'must be sigstore-oidc or sigstore-key',
    );
  return value;
}

export function decodeIdentity(parent: ObjectReader): Identity {
  const reader = parent.object('identity');
  const issuer = reader.optionalString('issuer');
  const pinWorkflow = reader.optionalBoolean('pin_workflow');
  return {
    scheme: scheme(reader),
    keyId: reader.string('key_id'),
    ...(issuer !== undefined && { issuer }),
    pinWorkflow: pinWorkflow ?? true,
  };
}

export function decodeEvidence(
  reader: ObjectReader,
  key: string,
  values: readonly JsonValue[] | undefined,
): Evidence[] {
  if (values === undefined) return [];
  return values.map((_, index) => {
    const entry = reader.element(key, index, values);
    const detail = entry.optionalString('detail');
    return {
      kind: entry.string('kind'),
      ...(detail !== undefined && { detail }),
    };
  });
}
