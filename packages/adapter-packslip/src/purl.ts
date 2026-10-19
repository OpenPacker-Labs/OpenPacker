import {
  ProviderError,
  echoed,
  formatPurl,
  parsePurl,
} from '@openpacker/adapter-core';
import {
  PackslipError,
  isSemver,
  parseProject,
  type Project,
} from '@openpacker/packslip';

/** The one PURL qualifier packslip defines: which published build to take. */
const QUALIFIERS = new Set(['variant']);

export interface PackslipPurl {
  readonly project: Project;
  /** Absent for a base PURL. */
  readonly version?: string;
  readonly variant?: string;
}

function invalid(message: string): ProviderError {
  return new ProviderError('INVALID_PURL', message);
}

/**
 * `pkg:packslip/github.com/jdx/hk@2.5.0` names the project `github.com/jdx/hk`
 * at version 2.5.0. The PURL namespace and name together are the project name,
 * so a vendor domain with no path is a PURL with only a name.
 *
 * An unknown qualifier is refused rather than ignored: a qualifier that
 * silently stopped meaning something would select a different build.
 */
export function parsePackslipPurl(purl: string): PackslipPurl {
  const parsed = parsePurl(purl);
  if (parsed.type !== 'packslip')
    throw invalid(`${echoed(purl)} is not a packslip PURL`);
  const name = [parsed.namespace, parsed.name]
    .filter((part): part is string => part !== undefined)
    .join('/');
  let project: Project;
  try {
    project = parseProject(name);
  } catch (error) {
    throw invalid(
      error instanceof PackslipError ? error.message : String(error),
    );
  }
  for (const key of Object.keys(parsed.qualifiers))
    if (!QUALIFIERS.has(key))
      throw invalid(`Unsupported packslip PURL qualifier "${echoed(key)}"`);
  const variant = parsed.qualifiers.variant;
  if (variant !== undefined && !/^[a-z0-9][a-z0-9_.-]*$/u.test(variant))
    throw invalid(`Invalid packslip variant "${echoed(variant)}"`);
  if (parsed.version !== undefined && !isSemver(parsed.version))
    throw invalid(`"${echoed(parsed.version)}" is not a semantic version`);
  if (parsed.subpath !== undefined)
    throw invalid('A packslip PURL has no subpath');
  return {
    project,
    ...(parsed.version !== undefined && { version: parsed.version }),
    ...(variant !== undefined && { variant }),
  };
}

export function formatPackslipPurl(
  project: Project,
  version?: string,
  variant?: string,
): string {
  const segments = project.name.split('/');
  const name = segments.pop() ?? project.name;
  return formatPurl({
    type: 'packslip',
    ...(segments.length > 0 && { namespace: segments.join('/') }),
    name,
    ...(version !== undefined && { version }),
    qualifiers: variant === undefined ? {} : { variant },
  });
}

/** The PURL without its version: what a lock keys a package's history by. */
export function basePurl(purl: string): string {
  const { project, variant } = parsePackslipPurl(purl);
  return formatPackslipPurl(project, undefined, variant);
}
