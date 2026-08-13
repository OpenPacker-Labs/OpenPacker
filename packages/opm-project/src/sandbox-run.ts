import {
  runInSandbox,
  type SandboxBackend,
  type SandboxOutcome,
  type SandboxPolicy,
} from '@openpacker/sandbox';
import type { PolicyInput } from '@openpacker/contracts';
import { sandboxPolicyFromProject } from './lifecycle.js';
import { OpmError } from './types.js';

/**
 * Run a package tool (opmx / ephemeral) under the project sandbox policy.
 *
 * Default: project + store RO, jail temp RW, network deny, fail-closed.
 * Set policy.projectWrite / sandbox.project_write to allow project mutation.
 */
export async function runSandboxedPackageProcess(input: {
  argv: readonly string[];
  cwd: string;
  projectRoot?: string;
  storePaths?: readonly string[];
  packageId?: string;
  policy?: PolicyInput;
  network?: boolean;
  env?: Readonly<Record<string, string>>;
  /** Test seam: inject a backend. Production callers omit this. */
  backend?: SandboxBackend;
}): Promise<SandboxOutcome> {
  if (input.argv.length === 0) {
    throw new OpmError('USAGE', 'runSandboxedPackageProcess requires argv');
  }
  const policy: SandboxPolicy = sandboxPolicyFromProject(input.policy);
  const projectWrite = policy.projectWrite === true;

  const projectRoot = input.projectRoot;
  const storePaths = input.storePaths ?? [];

  const readonlyPaths = [
    ...(projectRoot && !projectWrite ? [projectRoot] : []),
    ...storePaths,
  ];
  const readwritePaths = [
    ...(projectRoot && projectWrite ? [projectRoot] : []),
    // When cwd is outside project (rare), allow temp work only via jail home.
  ];

  // If cwd is the project and project is RO, cwd is still chdir'd RO by backend.
  // If tools need a scratch dir, they use $TMPDIR (jail home).
  const outcome = await runInSandbox({
    argv: input.argv,
    cwd: input.cwd,
    ...(input.env === undefined ? {} : { env: input.env }),
    policy,
    profile: 'package-exec',
    ...(input.packageId === undefined ? {} : { packageId: input.packageId }),
    readwritePaths,
    readonlyPaths,
    ...(input.network === undefined ? {} : { network: input.network }),
    ...(input.backend === undefined ? {} : { backend: input.backend }),
  });

  const mode = policy.mode ?? 'fail-closed';
  if (
    !outcome.enforced &&
    (mode === 'fail-closed' || policy.required !== false)
  ) {
    throw new OpmError(
      'SANDBOX_UNAVAILABLE',
      `Cannot run package process: sandbox was not enforced (backend=${outcome.backend})`,
    );
  }
  return outcome;
}
