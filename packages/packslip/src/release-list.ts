import type { JsonValue } from '@openpacker/contracts';
import {
  assertStatementFrame,
  decodeEvidence,
  decodeIdentity,
  decodeSubjects,
  timestamp,
} from './decode.js';
import { PackslipError } from './errors.js';
import { ObjectReader, isJsonObject } from './json.js';
import { parseProject } from './project.js';
import type { ReleaseEntry, ReleaseList } from './types.js';
import { RELEASES_PREDICATE } from './types.js';
import { assertSemver } from './version.js';
import { shown } from './shown.js';

function invalid(message: string): PackslipError {
  return new PackslipError('INVALID_STATEMENT', message);
}

function decodeEntry(
  parent: ObjectReader,
  values: readonly JsonValue[],
  index: number,
): ReleaseEntry {
  const reader = parent.element('releases', index, values);
  const version = reader.string('version');
  assertSemver(version, `${reader.path}.version`);
  const status = reader.optionalString('status');
  const tag = reader.optionalString('tag');
  const statusReason = reader.optionalString('status_reason');
  const extensions = reader.optionalExtensions();
  return {
    version,
    ...(tag !== undefined && { tag }),
    publishedAt: timestamp(reader, 'published_at'),
    packslip: reader.string('packslip'),
    // Only `yanked` is defined; any other status is a word this consumer does not know.
    yanked: status === 'yanked',
    ...(statusReason !== undefined && { statusReason }),
    security: reader.optionalBoolean('security') ?? false,
    evidence: decodeEvidence(
      reader,
      'evidence',
      reader.optionalArray('evidence'),
    ),
    ...(extensions !== undefined && { extensions }),
  };
}

/**
 * Decode a `releases/v1` list and check what makes it coherent: every entry
 * pins a bundle by digest through a subject of the same name, no version
 * appears twice, and `latest` names a listed version exactly. Expiry and
 * sequence depend on the clock and on what the consumer accepted before, so
 * they are checked separately.
 */
export function decodeReleaseList(value: JsonValue): ReleaseList {
  if (!isJsonObject(value)) throw invalid('the release list must be an object');
  const root = new ObjectReader(value, '');
  assertStatementFrame(root, RELEASES_PREDICATE);
  const subjects = decodeSubjects(root);
  const predicate = root.object('predicate');
  const project = predicate.string('project');
  try {
    parseProject(project);
  } catch (error) {
    throw invalid(
      `predicate.project: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const entryValues = predicate.array('releases');
  const releases = entryValues.map((_, index) =>
    decodeEntry(predicate, entryValues, index),
  );
  const versions = new Set<string>();
  const urls = new Set<string>();
  const subjectNames = new Set(subjects.map((subject) => subject.name));
  for (const release of releases) {
    if (versions.has(release.version))
      throw invalid(`version ${shown(release.version)} is listed twice`);
    versions.add(release.version);
    urls.add(release.packslip);
    if (!subjectNames.has(release.packslip))
      throw invalid(
        `release ${shown(release.version)} has no subject digest for ${shown(release.packslip)}`,
      );
  }
  for (const subject of subjects)
    if (!urls.has(subject.name))
      throw invalid(`subject ${shown(subject.name)} is not a listed release`);
  const latest = predicate.optionalString('latest');
  if (latest !== undefined && !versions.has(latest))
    throw invalid(`latest ${shown(latest)} is not a listed version`);
  const sequence = predicate.integer('sequence');
  const extensions = predicate.optionalExtensions();
  return {
    subjects,
    project,
    generatedAt: timestamp(predicate, 'generated_at'),
    expiresAt: timestamp(predicate, 'expires_at'),
    sequence,
    ...(latest !== undefined && { latest }),
    identity: decodeIdentity(predicate),
    releases,
    ...(extensions !== undefined && { extensions }),
  };
}

/** A consumer refuses an expired list, so a mirror cannot serve an old view forever. */
export function assertListFresh(list: ReleaseList, now: Date): void {
  if (Date.parse(list.expiresAt) <= now.getTime())
    throw new PackslipError(
      'LIST_EXPIRED',
      `The signed release list for ${shown(list.project)} expired at ${shown(list.expiresAt)}`,
    );
}

/**
 * Rollback protection: a list older than one already accepted is refused. An
 * equal sequence is the same list again and is fine.
 */
export function assertListSequence(
  list: ReleaseList,
  highestAccepted: number | undefined,
): void {
  if (highestAccepted !== undefined && list.sequence < highestAccepted)
    throw new PackslipError(
      'LIST_ROLLBACK',
      `The signed release list for ${shown(list.project)} has sequence ${list.sequence}, below the accepted ${highestAccepted}`,
    );
}
