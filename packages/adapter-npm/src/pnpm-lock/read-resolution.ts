/**
 * `resolution`: where a package's bytes come from. pnpm writes five shapes,
 * told apart by `type` (`directory`, `git`, `variations`) or, when it is
 * absent, by whether there is a `tarball`.
 *
 * ```yaml
 * resolution: {integrity: sha512-...}                              # the registry
 * resolution: {tarball: https://codeload.github.com/o/r/tar.gz/<sha>}
 * resolution: {directory: ../vendor/a, type: directory}
 * resolution: {commit: <sha>, repo: https://host/o/r.git, type: git}
 * resolution: {type: variations, variants: [{resolution: {type: binary, ...}, targets: [...]}]}
 * ```
 *
 * This reads the shape and checks each part is well formed. It does not decide
 * whether a source is allowed, and it never contacts one.
 */

import { quote } from '@openpacker/adapter-core';
import { PnpmLockError, shown } from './errors.js';
import { checkLimit } from './limits.js';
import {
  asList,
  asMap,
  asString,
  field,
  rejectUnknown,
  type ReadContext,
} from './read-support.js';
import {
  integrityProblem,
  isGitCommit,
  relativePathProblem,
  tarballUrlProblem,
  urlProblem,
} from './source.js';
import type {
  PnpmResolution,
  PnpmRuntimeTarget,
  PnpmRuntimeVariant,
} from './types.js';
import type { YamlMap, YamlValue } from './yaml-tree.js';

function integrityAt(value: YamlValue | undefined, where: string): string {
  const integrity = asString(value, where);
  const problem = integrityProblem(integrity);
  if (problem !== undefined)
    throw new PnpmLockError(
      'integrity',
      `${problem}: ${quote(integrity)}`,
      where,
    );
  return integrity;
}

function relativeAt(value: YamlValue | undefined, where: string): string {
  const path = asString(value, where);
  const problem = relativePathProblem(path);
  if (problem !== undefined)
    throw new PnpmLockError('unsafe-path', `${problem}`, where);
  return path;
}

function tarballAt(value: YamlValue | undefined, where: string): string {
  const tarball = asString(value, where);
  const problem = tarball.startsWith('file:')
    ? relativePathProblem(tarball.slice(5))
    : tarballUrlProblem(tarball);
  if (problem !== undefined)
    throw new PnpmLockError('url', `${problem}`, where);
  return tarball;
}

function readBinary(
  value: YamlValue | undefined,
  where: string,
): Omit<PnpmRuntimeVariant, 'targets'> {
  const record = asMap(value, where);
  rejectUnknown(
    record,
    ['type', 'archive', 'url', 'integrity', 'bin', 'prefix'],
    where,
  );
  if (record.get('type') !== 'binary')
    throw new PnpmLockError('shape', 'must have type: binary', where);
  const archive = asString(record.get('archive'), field(where, 'archive'));
  if (archive !== 'tarball' && archive !== 'zip')
    throw new PnpmLockError(
      'shape',
      'archive must be tarball or zip',
      field(where, 'archive'),
    );
  const url = asString(record.get('url'), field(where, 'url'));
  const problem = tarballUrlProblem(url);
  if (problem !== undefined)
    throw new PnpmLockError('url', problem, field(where, 'url'));
  const prefix = record.get('prefix');
  return {
    archive,
    url,
    integrity: integrityAt(record.get('integrity'), field(where, 'integrity')),
    bin: relativeAt(record.get('bin'), field(where, 'bin')),
    ...(prefix !== undefined && {
      prefix: relativeAt(prefix, field(where, 'prefix')),
    }),
  };
}

function readTarget(value: YamlValue, where: string): PnpmRuntimeTarget {
  const record = asMap(value, where);
  rejectUnknown(record, ['os', 'cpu', 'libc'], where);
  const libc = record.get('libc');
  return {
    os: asString(record.get('os'), field(where, 'os')),
    cpu: asString(record.get('cpu'), field(where, 'cpu')),
    ...(libc !== undefined && { libc: asString(libc, field(where, 'libc')) }),
  };
}

function readVariants(
  value: YamlValue | undefined,
  where: string,
  ctx: ReadContext,
): PnpmRuntimeVariant[] {
  const list = asList(value, where);
  checkLimit(
    list.length,
    ctx.limits.maxEntries,
    'runtime variants',
    'maxEntries',
    where,
  );
  return list.map((item, index) => {
    const here = `${where}[${index}]`;
    const record = asMap(item, here);
    rejectUnknown(record, ['resolution', 'targets'], here);
    const targets = asList(record.get('targets'), field(here, 'targets'));
    checkLimit(
      targets.length,
      ctx.limits.maxEntries,
      'runtime targets',
      'maxEntries',
      here,
    );
    return {
      targets: targets.map((target, at) =>
        readTarget(target, `${field(here, 'targets')}[${at}]`),
      ),
      ...readBinary(record.get('resolution'), field(here, 'resolution')),
    };
  });
}

function readGit(record: YamlMap, where: string): PnpmResolution {
  rejectUnknown(record, ['type', 'repo', 'commit', 'path'], where);
  const repo = asString(record.get('repo'), field(where, 'repo'));
  const repoProblem = urlProblem(repo, 'git');
  if (repoProblem !== undefined)
    throw new PnpmLockError(
      'url',
      `git repository ${repoProblem}`,
      field(where, 'repo'),
    );
  const commit = asString(record.get('commit'), field(where, 'commit'));
  if (!isGitCommit(commit))
    throw new PnpmLockError(
      'shape',
      'must be a full 40 or 64 digit commit hash',
      field(where, 'commit'),
    );
  const path = record.get('path');
  return {
    kind: 'git',
    repo,
    commit,
    ...(path !== undefined && { path: relativeAt(path, field(where, 'path')) }),
  };
}

function readUntyped(record: YamlMap, where: string): PnpmResolution {
  rejectUnknown(record, ['integrity', 'tarball', 'path'], where);
  const integrity = record.get('integrity');
  const tarball = record.get('tarball');
  const path = record.get('path');
  if (tarball === undefined) {
    if (integrity === undefined || path !== undefined)
      throw new PnpmLockError(
        'shape',
        'must have an integrity, a tarball, a directory, or be a git or variations resolution',
        where,
      );
    return {
      kind: 'integrity',
      integrity: integrityAt(integrity, field(where, 'integrity')),
    };
  }
  return {
    kind: 'tarball',
    tarball: tarballAt(tarball, field(where, 'tarball')),
    ...(integrity !== undefined && {
      integrity: integrityAt(integrity, field(where, 'integrity')),
    }),
    ...(path !== undefined && { path: relativeAt(path, field(where, 'path')) }),
  };
}

export function readResolution(
  value: YamlValue | undefined,
  where: string,
  ctx: ReadContext,
): PnpmResolution {
  const record = asMap(value, where);
  const type = record.get('type');
  if (type === undefined) return readUntyped(record, where);
  if (type === 'directory') {
    rejectUnknown(record, ['type', 'directory'], where);
    return {
      kind: 'directory',
      directory: relativeAt(record.get('directory'), field(where, 'directory')),
    };
  }
  if (type === 'git') return readGit(record, where);
  if (type === 'variations') {
    rejectUnknown(record, ['type', 'variants'], where);
    return {
      kind: 'variations',
      variants: readVariants(
        record.get('variants'),
        field(where, 'variants'),
        ctx,
      ),
    };
  }
  throw new PnpmLockError(
    'shape',
    `has the resolution type ${shown(type)}, which pnpm 9 and 10 do not write for a package`,
    where,
  );
}
