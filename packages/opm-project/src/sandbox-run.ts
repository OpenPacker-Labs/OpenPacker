import {
  runInSandbox,
  type SandboxOutcome,
  type SandboxPolicy,
} from '@openpacker/sandbox';
import type { PolicyInput } from '@openpacker/contracts';
import { sandboxPolicyFromProject } from './lifecycle.js';
import { OpmError } from './types.js';

/**
 * Run a package tool (opmx / ephemeral) under the project sandbox policy.
 *
 * Default profile: network deny, project + store roots RO, temp RW via jail.
 */
export async function runSandboxedPackageProcess(input: {
  argv: readonly string[];
  cwd: string;
  /** Project root for RO mount; optional for pure ephemeral cache runs. */
  projectRoot?: string;
  /** Content-addressed store roots the tool may read. */
  storePaths?: readonly string[];
  packageId?: string;
  policy?: PolicyInput;
  /** Allow outbound network (explicit). */
  network?: boolean;
  env?: Readonly<Record<string, string>>;
}): Promise<SandboxOutcome> {
  if (input.argv.length === 0) {
    throw new OpmError('USAGE', 'runSandboxedPackageProcess requires argv');
  }
  const policy: SandboxPolicy = sandboxPolicyFromProject(input.policy);
  const readonlyPaths = [
    ...(input.projectRoot ? [input.projectRoot] : []),
    ...(input.storePaths ?? []),
  ];
  // Writable: only jail temp (added by runInSandbox) unless grants add more.
  const outcome = await runInSandbox({
    argv: input.argv,
    cwd: input.cwd,
    ...(input.env === undefined ? {} : { env: input.env }),
    policy,
    ...(input.packageId === undefined ? {} : { packageId: input.packageId }),
    readwritePaths: [input.cwd],
    readonlyPaths,
    ...(input.network === undefined ? {} : { network: input.network }),
  });

  if (
    !outcome.enforced &&
    outcome.backend === 'none' &&
    (policy.mode ?? 'fail-closed') === 'fail-closed'
  ) {
    throw new OpmError(
      'SANDBOX_UNAVAILABLE',
      'Cannot run package process: sandbox unavailable (fail-closed)',
    );
  }
  return outcome;
}
