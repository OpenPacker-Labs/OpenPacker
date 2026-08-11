import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createMxcBackend, probeMxc } from './backends/mxc.js';
import {
  createMockBackend,
  SandboxBackendError,
  spawnCapture,
} from './backends/mock.js';
import { createNativeBackend, probeNativeBackends } from './backends/native.js';
import { defaultJailHomeRoot, scrubEnvironment } from './env.js';
import {
  backendLosses,
  digestSandboxPolicy,
  loss,
  matchPackageGrant,
  mergeGrants,
  resolvePolicy,
} from './policy.js';
import {
  SANDBOX_LOSS,
  type BackendProbe,
  type RunInSandboxInput,
  type SandboxBackend,
  type SandboxBackendId,
  type SandboxOutcome,
  type SandboxPrefer,
} from './types.js';

export async function probeBackends(): Promise<BackendProbe[]> {
  const mxc = await probeMxc();
  return [mxc, ...probeNativeBackends()];
}

/**
 * Select a backend for the preferred ladder. Does not include mock unless
 * nothing else exists and the caller is in tests (mock is inject-only).
 *
 * Under `auto`, prefer a working native jail when one is present (Linux bwrap /
 * macOS seatbelt). MXC is still preferred when native is missing (typical
 * Windows) or when the caller forces `prefer: "mxc"`. MXC remains early
 * preview — native-first on capable hosts avoids hung MXC launches.
 */
export async function resolveBackend(
  prefer: SandboxPrefer = 'auto',
): Promise<SandboxBackend | undefined> {
  if (prefer === 'mxc') {
    try {
      return await createMxcBackend();
    } catch {
      return undefined;
    }
  }
  if (prefer === 'native') {
    return createNativeBackend();
  }
  // auto: native when available, else MXC
  const native = createNativeBackend();
  if (native) return native;
  try {
    return await createMxcBackend();
  } catch {
    return undefined;
  }
}

/**
 * Run argv inside the sandbox policy.
 *
 * Single funnel for lifecycle scripts, opmx, and host installers.
 */
export async function runInSandbox(
  input: RunInSandboxInput,
): Promise<SandboxOutcome> {
  const resolved = resolvePolicy(input.policy);
  const policyDigest = await digestSandboxPolicy(input.policy);
  const packageGrants = mergeGrants(
    matchPackageGrant(input.packageId, input.policy.packages),
    input.grants,
  );
  const network = Boolean(input.network || packageGrants.network);

  if (!resolved.enabled || resolved.mode === 'off') {
    const result = await runAmbient(input, packageGrants.env);
    return {
      ...result,
      backend: 'off',
      enforced: false,
      policyDigest,
      degraded: true,
      losses: [
        ...backendLosses('off', false, true),
        loss(
          SANDBOX_LOSS.DEGRADED,
          'warning',
          'sandbox disabled by policy',
          'ambient execution; not a security boundary',
        ),
      ],
    };
  }

  let backend: SandboxBackend | undefined = input.backend;
  if (!backend) {
    backend = await resolveBackend(resolved.prefer);
  }

  if (!backend) {
    if (resolved.mode === 'fail-closed' || resolved.required) {
      return {
        exitCode: 78, // EX_CONFIG spirit
        stdout: '',
        stderr:
          'openpacker sandbox: no containment backend available (fail-closed)\n',
        backend: 'none',
        enforced: false,
        policyDigest,
        degraded: false,
        losses: backendLosses('none', false, false),
      };
    }
    // degrade-warn
    const result = await runAmbient(input, packageGrants.env);
    return {
      ...result,
      backend: 'none',
      enforced: false,
      policyDigest,
      degraded: true,
      losses: backendLosses('none', false, true),
    };
  }

  const jailRoot = defaultJailHomeRoot();
  await mkdir(jailRoot, { recursive: true });
  const jailHome = await mkdtemp(join(jailRoot, 'home-'));
  try {
    await mkdir(join(jailHome, 'tmp'), { recursive: true });
    const env = scrubEnvironment({
      ...(input.env === undefined ? {} : { extra: input.env }),
      ...(packageGrants.env === undefined
        ? {}
        : { grantEnv: packageGrants.env }),
      jailHome,
    });
    const readwrite = [
      ...input.readwritePaths,
      jailHome,
      ...(packageGrants.write ?? []),
    ];
    const readonly = [...input.readonlyPaths, ...(packageGrants.read ?? [])];

    try {
      let active = backend;
      let result = await active.run({
        argv: input.argv,
        cwd: input.cwd,
        env,
        readwritePaths: readwrite,
        readonlyPaths: readonly,
        network,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });

      // MXC is preferred but early preview. When it returns a containment
      // launch failure and native is available under auto, fall through once.
      if (
        result.exitCode !== 0 &&
        active.id === 'mxc' &&
        resolved.prefer === 'auto' &&
        !input.backend
      ) {
        const native = createNativeBackend();
        if (native) {
          active = native;
          result = await active.run({
            argv: input.argv,
            cwd: input.cwd,
            env,
            readwritePaths: readwrite,
            readonlyPaths: readonly,
            network,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
        }
      }

      return {
        ...result,
        backend: active.id,
        enforced: active.id !== 'mock' && active.id !== 'off',
        policyDigest,
        degraded: false,
        losses: backendLosses(
          active.id,
          active.id !== 'mock' && active.id !== 'off',
          false,
        ),
      };
    } catch (error) {
      if (
        error instanceof SandboxBackendError &&
        error.code === 'UNAVAILABLE'
      ) {
        // Prefer native when MXC claimed support then could not start.
        if (
          backend.id === 'mxc' &&
          resolved.prefer === 'auto' &&
          !input.backend
        ) {
          const native = createNativeBackend();
          if (native) {
            const result = await native.run({
              argv: input.argv,
              cwd: input.cwd,
              env,
              readwritePaths: readwrite,
              readonlyPaths: readonly,
              network,
              ...(input.signal === undefined ? {} : { signal: input.signal }),
            });
            return {
              ...result,
              backend: native.id,
              enforced: true,
              policyDigest,
              degraded: false,
              losses: backendLosses(native.id, true, false),
            };
          }
        }
        if (resolved.mode === 'fail-closed' || resolved.required) {
          return {
            exitCode: 78,
            stdout: '',
            stderr: `openpacker sandbox: ${error.message}\n`,
            backend: 'none',
            enforced: false,
            policyDigest,
            degraded: false,
            losses: backendLosses('none', false, false),
          };
        }
        const result = await runAmbient(input, packageGrants.env);
        return {
          ...result,
          backend: 'none',
          enforced: false,
          policyDigest,
          degraded: true,
          losses: backendLosses('none', false, true),
        };
      }
      throw error;
    }
  } finally {
    await rm(jailHome, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runAmbient(
  input: RunInSandboxInput,
  grantEnv: readonly string[] | undefined,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const jailRoot = defaultJailHomeRoot();
  await mkdir(jailRoot, { recursive: true });
  const jailHome = await mkdtemp(join(jailRoot, 'ambient-'));
  try {
    await mkdir(join(jailHome, 'tmp'), { recursive: true });
    const env = scrubEnvironment({
      ...(input.env === undefined ? {} : { extra: input.env }),
      ...(grantEnv === undefined ? {} : { grantEnv }),
      jailHome,
    });
    return await spawnCapture({
      argv: input.argv,
      cwd: input.cwd,
      env,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } finally {
    await rm(jailHome, { recursive: true, force: true }).catch(() => undefined);
  }
}

export { createMockBackend };
export type { SandboxBackendId };
