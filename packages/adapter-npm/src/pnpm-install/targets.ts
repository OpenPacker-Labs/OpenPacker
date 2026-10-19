/**
 * The machines an install is for (ADR 0055 §19).
 *
 * The host alone by default. `--os`, `--cpu` and `--libc` replace a dimension
 * of that (the host builds the list), and `--supported-architectures project`
 * takes the project's own `supportedArchitectures`, where `current` is the
 * host, as it is in pnpm. A package is installed when it runs on any one of
 * the machines, which is pnpm's rule: every dimension it restricts has a
 * supported value that satisfies it.
 */

import { ProviderError } from '@openpacker/adapter-core';
import type { FrozenLockOptions, NativeTarget } from '@openpacker/adapter-core';
import type { PnpmProjectConfig } from './config.js';

/** Every combination of the three lists, for the machines `current` stands for. */
function combine(
  host: NativeTarget,
  os: readonly string[],
  cpu: readonly string[],
  libc: readonly string[],
): NativeTarget[] {
  const now = (value: string, current: string | undefined) =>
    value === 'current' ? current : value;
  const seen = new Set<string>();
  const out: NativeTarget[] = [];
  for (const o of os)
    for (const c of cpu)
      for (const l of libc) {
        const machine: NativeTarget = {
          os: now(o, host.os)!,
          architecture: now(c, host.architecture)!,
        };
        // libc means something on linux only.
        const lib = machine.os === 'linux' ? now(l, host.libc) : undefined;
        if (lib !== undefined) machine.libc = lib;
        const key = `${machine.os}/${machine.architecture}/${machine.libc ?? ''}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(machine);
        }
      }
  return out;
}

export function platformsOf(
  options: FrozenLockOptions,
  config: PnpmProjectConfig,
): readonly NativeTarget[] {
  if (options.architectures !== 'project')
    return options.targets ?? [options.target];
  const wanted = config.supportedArchitectures;
  if (wanted === undefined)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      'opm ci --supported-architectures project: the project sets no supportedArchitectures (in package.json pnpm.supportedArchitectures or pnpm-workspace.yaml), so there is nothing to take; name the platforms with --os, --cpu and --libc',
    );
  return combine(options.target, wanted.os, wanted.cpu, wanted.libc);
}
