import type { Artifact, HostRequirements } from './types.js';
import { shown } from './shown.js';

/**
 * What a consumer can learn about the machine. Every probe may answer
 * `undefined` for "I cannot tell": an unknown check warns and never refuses.
 */
export interface HostFacts {
  readonly os: string;
  /** Kernel version on Linux, product version on macOS, build on Windows. */
  readonly osVersion?: string;
  readonly glibcVersion?: string;
  /** Whether the loader would find a shared library by its loader name. */
  readonly hasLibrary?: (name: string) => boolean | undefined;
  /** Whether a command is on PATH, and its version when the consumer knows it. */
  readonly command?: (
    name: string,
  ) => { readonly found: boolean; readonly version?: string } | undefined;
}

export interface RequirementReport {
  /** Failures that stop the executables from starting: install is refused. */
  readonly refusals: readonly string[];
  /** Things the user should know that do not stop installation. */
  readonly warnings: readonly string[];
}

/** Dotted nonnegative integers, or `undefined` for any spelling that is not. */
function dotted(text: string): number[] | undefined {
  // A kernel release such as 6.18.44-fc-v114 or 5.15.0+ keeps only its numbers.
  const match = /^(\d+(?:\.\d+)*)/u.exec(text.trim());
  if (match?.[1] === undefined) return undefined;
  const parts = match[1].split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : undefined;
}

/**
 * `-1`, `0`, `1` as `left` is below, equal to, or above `right`; `undefined`
 * when either spelling cannot be compared. Missing components count as zero,
 * so `2.10` exceeds `2.9` and a minimum of `17` admits `21`.
 */
export function compareDotted(left: string, right: string): number | undefined {
  const a = dotted(left);
  const b = dotted(right);
  if (a === undefined || b === undefined) return undefined;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Check the selected artifact's declared requirements against the host.
 *
 * A missing library, an old glibc, or an old OS stops the executables from
 * starting, so those refuse. A missing command only affects the code paths that
 * call it, and the user may be about to install it, so that warns. Anything the
 * consumer cannot check warns too.
 */
export function checkRequirements(
  artifact: Artifact,
  host: HostFacts,
): RequirementReport {
  const refusals: string[] = [];
  const warnings: string[] = [];
  const requires: HostRequirements | undefined = artifact.requires;
  if (requires === undefined) return { refusals, warnings };

  if (requires.osMin !== undefined) {
    const order =
      host.osVersion === undefined
        ? undefined
        : compareDotted(host.osVersion, requires.osMin);
    if (order === undefined)
      warnings.push(
        `Could not compare the ${host.os} version with the required minimum ${shown(requires.osMin)}`,
      );
    else if (order < 0)
      refusals.push(
        `Requires ${host.os} ${shown(requires.osMin)} or newer; this host has ${shown(host.osVersion)}`,
      );
  }

  // glibc_min only means something for a gnu Linux build.
  if (requires.glibcMin !== undefined && artifact.libc === 'gnu') {
    const order =
      host.glibcVersion === undefined
        ? undefined
        : compareDotted(host.glibcVersion, requires.glibcMin);
    if (order === undefined)
      warnings.push(
        `Could not read this host's glibc version to compare with the required ${shown(requires.glibcMin)}`,
      );
    else if (order < 0)
      refusals.push(
        `Requires glibc ${shown(requires.glibcMin)} or newer; this host has ${shown(host.glibcVersion)}`,
      );
  }

  for (const library of requires.libs ?? []) {
    const present = host.hasLibrary?.(library);
    if (present === undefined)
      warnings.push(`Could not check for the shared library ${shown(library)}`);
    else if (!present)
      refusals.push(
        `Requires the shared library ${shown(library)}, which is not installed`,
      );
  }

  for (const required of requires.bin ?? []) {
    const probe = host.command?.(required.name);
    if (probe === undefined) {
      warnings.push(`Could not check for the command ${shown(required.name)}`);
    } else if (!probe.found) {
      warnings.push(
        `Needs the command ${shown(required.name)}${required.min === undefined ? '' : ` ${shown(required.min)} or newer`}, which is not on PATH`,
      );
    } else if (required.min !== undefined) {
      const order =
        probe.version === undefined
          ? undefined
          : compareDotted(probe.version, required.min);
      if (order === undefined)
        warnings.push(
          `Could not read the version of ${shown(required.name)} to compare with the required ${shown(required.min)}`,
        );
      else if (order < 0)
        warnings.push(
          `Needs ${shown(required.name)} ${shown(required.min)} or newer; found ${shown(probe.version)}`,
        );
    }
  }
  return { refusals, warnings };
}
