import {
  inheritedHandleCount,
  MAX_INHERITED_HANDLES,
  runInSandbox,
  type OutputSink,
  type SandboxBackend,
  type SandboxOutcome,
  type SandboxPolicy,
} from '@openpacker/sandbox';
import type { PolicyInput } from '@openpacker/contracts';
import { platformNote, sandboxPolicyFromProject } from './lifecycle.js';
import { parseRunTimeout } from './run-timeout.js';
import { storeViews } from './store-view.js';
import { OpmError } from './types.js';

/**
 * Run a package tool (opmx / ephemeral) under the project sandbox policy.
 *
 * Default: project + store RO, jail temp RW, network deny, fail-closed.
 * Set policy.projectWrite / sandbox.project_write to allow project mutation.
 *
 * A tool runs for as long as it runs, as one started by `npx` does: someone
 * started it and stops it, and a server is meant to keep running. Its limit
 * is `timeoutMs` when given (`opmx --timeout`), else the project's
 * `[sandbox] opmx_timeout_ms`, else none. The project's `timeout_ms` bounds
 * what runs unattended, an install's lifecycle scripts, and not this.
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
  /** Ends the process tree when aborted; the run's views are still removed. */
  signal?: AbortSignal;
  /** Directories put first on the process's PATH (a layout's `.bin`). */
  pathPrefix?: readonly string[];
  /** Wall-clock limit in whole milliseconds, 0 for none (`opmx --timeout`). */
  timeoutMs?: number;
  /**
   * Hand the output on as the process writes it, rather than return it in the
   * outcome (`@openpacker/sandbox`'s `RunInSandboxInput.output`).
   */
  output?: OutputSink;
  /** Test seam: inject a backend. Production callers omit this. */
  backend?: SandboxBackend;
}): Promise<SandboxOutcome> {
  if (input.argv.length === 0) {
    throw new OpmError('USAGE', 'runSandboxedPackageProcess requires argv');
  }
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const ext = input.policy as
    | (PolicyInput & { opmxTimeoutMs?: number })
    | undefined;
  const policy: SandboxPolicy = {
    ...sandboxPolicyFromProject(input.policy),
    timeoutMs: parseRunTimeout(
      String(input.timeoutMs ?? ext?.opmxTimeoutMs ?? 0),
      input.timeoutMs === undefined
        ? 'sandbox.opmx_timeout_ms'
        : 'The run timeout',
    ),
  };
  const projectWrite = policy.projectWrite === true;

  const projectRoot = input.projectRoot;
  const storePaths = input.storePaths ?? [];

  const projectRo = projectRoot && !projectWrite ? [projectRoot] : [];
  const readwritePaths = projectRoot && projectWrite ? [projectRoot] : [];
  // The store entries get the handles the rest of the run leaves; past that,
  // one handle per store however many of its entries the tool needs.
  const besides = inheritedHandleCount({
    policy,
    ...(!(input.packageId === undefined) && { packageId: input.packageId }),
    readwritePaths,
    readonlyPaths: projectRo,
    cwd: input.cwd,
  });
  const view = await storeViews(storePaths, MAX_INHERITED_HANDLES - besides);
  const readonlyPaths = [...projectRo, ...view.readonlyPaths];

  // If cwd is the project and project is RO, cwd is still chdir'd RO by backend.
  // If tools need a scratch dir, they use $TMPDIR (jail home).
  let outcome: SandboxOutcome;
  try {
    outcome = await runInSandbox({
      argv: input.argv,
      cwd: input.cwd,
      ...(!(input.env === undefined) && { env: input.env }),
      policy,
      profile: 'package-exec',
      ...(!(input.packageId === undefined) && { packageId: input.packageId }),
      readwritePaths,
      readonlyPaths,
      directoryAuthorities: view.authorities,
      ...(!(input.network === undefined) && { network: input.network }),
      ...(!(input.signal === undefined) && { signal: input.signal }),
      ...(!(input.pathPrefix === undefined) && {
        pathPrefix: input.pathPrefix,
      }),
      ...(!(input.output === undefined) && { output: input.output }),
      ...(!(input.backend === undefined) && { backend: input.backend }),
    });
  } finally {
    await view.dispose();
  }

  const mode = policy.mode ?? 'fail-closed';
  if (
    !outcome.enforced &&
    (mode === 'fail-closed' || policy.required !== false)
  ) {
    throw new OpmError(
      'SANDBOX_UNAVAILABLE',
      `Cannot run package process: sandbox was not enforced (backend=${outcome.backend})${platformNote()}`,
    );
  }
  return outcome;
}
