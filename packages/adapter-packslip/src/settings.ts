import type { JsonValue } from '@openpacker/contracts';
import {
  PackslipError,
  assertFingerprint,
  isJsonObject,
  parseMinisignPublicKey,
  parseProject,
  type JsonObject,
  type SignerConfig,
} from '@openpacker/packslip';

/**
 * What a project says about packslip: who may sign each tool it uses, which
 * trust changes a person approved this run, and whether to install on a host
 * that does not meet a hard requirement.
 */
export interface PackslipSettings {
  /** Signer configuration by project name. */
  readonly signers: Readonly<Record<string, SignerConfig>>;
  /** Proposal ids a person approved. */
  readonly approvals: readonly string[];
  readonly allowIncompatibleHost: boolean;
}

export const EMPTY_SETTINGS: PackslipSettings = {
  signers: {},
  approvals: [],
  allowIncompatibleHost: false,
};

const SIGNER_KEYS = new Set([
  'pin',
  'public_key',
  'identity',
  'identity_prefix',
  'issuer',
  'source_repository',
  'allow_unlogged',
]);

function refuse(message: string): PackslipError {
  return new PackslipError('INVALID_INPUT', `packslip settings: ${message}`);
}

function text(value: JsonValue | undefined, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '')
    throw refuse(`${where} must be a non-empty string`);
  return value;
}

function textList(
  value: JsonValue | undefined,
  where: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  const items = Array.isArray(value) ? value : [value];
  return items.map((item, index) => {
    if (typeof item !== 'string' || item === '')
      throw refuse(`${where}[${index}] must be a non-empty string`);
    return item;
  });
}

function decodeSigner(project: string, value: JsonValue): SignerConfig {
  const where = `trust."${project}"`;
  if (!isJsonObject(value)) throw refuse(`${where} must be a table`);
  // An unknown key is an error, not a no-op: a misspelled `pin` that is
  // silently dropped is a project that quietly trusts whoever signs.
  for (const key of Object.keys(value))
    if (!SIGNER_KEYS.has(key))
      throw refuse(`${where} has unknown key "${key}"`);
  const pins = textList(value.pin, `${where}.pin`);
  for (const pin of pins ?? []) assertFingerprint(pin);
  const publicKey = text(value.public_key, `${where}.public_key`);
  if (publicKey !== undefined) parseMinisignPublicKey(publicKey);
  const identity = text(value.identity, `${where}.identity`);
  const identityPrefix = text(
    value.identity_prefix,
    `${where}.identity_prefix`,
  );
  const issuer = text(value.issuer, `${where}.issuer`);
  const sourceRepository = text(
    value.source_repository,
    `${where}.source_repository`,
  );
  const unlogged = value.allow_unlogged;
  if (unlogged !== undefined && typeof unlogged !== 'boolean')
    throw refuse(`${where}.allow_unlogged must be a boolean`);
  if (
    publicKey !== undefined &&
    (pins !== undefined ||
      identity !== undefined ||
      identityPrefix !== undefined ||
      issuer !== undefined ||
      sourceRepository !== undefined)
  )
    throw refuse(`${where} combines a public key with a keyless identity`);
  return {
    ...(pins !== undefined && { pins }),
    ...(publicKey !== undefined && { publicKey }),
    ...(identity !== undefined && { identity }),
    ...(identityPrefix !== undefined && { identityPrefix }),
    ...(issuer !== undefined && { issuer }),
    ...(sourceRepository !== undefined && { sourceRepository }),
    ...(unlogged !== undefined && { allowUnlogged: unlogged }),
  };
}

/** How a project name is keyed in `PackslipSettings.signers`. */
export function trustKey(project: string): string {
  return project.toLowerCase();
}

/**
 * Decode the JSON the host hands an adapter. Strict by design: unknown keys,
 * malformed fingerprints, and malformed public keys are refused here, before a
 * single network request, because configuration is a trust anchor.
 */
export function decodeSettings(raw: JsonObject | undefined): PackslipSettings {
  if (raw === undefined) return EMPTY_SETTINGS;
  for (const key of Object.keys(raw))
    if (
      key !== 'trust' &&
      key !== 'approvals' &&
      key !== 'allow_incompatible_host'
    )
      throw refuse(`unknown setting "${key}"`);
  const signers: Record<string, SignerConfig> = {};
  const trust = raw.trust;
  if (trust !== undefined) {
    if (!isJsonObject(trust)) throw refuse('trust must be a table');
    for (const [project, value] of Object.entries(trust)) {
      // The key is a project name; a typo here would trust no one, so check it.
      parseProject(project);
      // Forge names are case-insensitive, so a pin spelled `…/HK` must govern
      // `…/hk`: matched exactly it would be skipped without a word, and the
      // project would fall back to the weaker forge-derived trust. Two entries
      // that differ only by case are one project written twice.
      const name = trustKey(project);
      if (Object.hasOwn(signers, name))
        throw refuse(
          `trust has two entries for ${project} that differ only by case`,
        );
      signers[name] = decodeSigner(project, value);
    }
  }
  const approvals = textList(raw.approvals, 'approvals') ?? [];
  const allow = raw.allow_incompatible_host;
  if (allow !== undefined && typeof allow !== 'boolean')
    throw refuse('allow_incompatible_host must be a boolean');
  return { signers, approvals, allowIncompatibleHost: allow ?? false };
}
