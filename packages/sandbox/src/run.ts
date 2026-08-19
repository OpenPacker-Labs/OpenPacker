import { mkdir, mkdtemp, rm, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createMxcBackend, probeMxc } from './backends/mxc.js';
import {
  createMockBackend,
  SandboxBackendError,
  spawnCapture,
} from './backends/mock.js';
import { createNativeBackend, probeNativeBackends } from './backends/native.js';
import { defaultJailHomeRoot, scrubEnvironment } from './env.js';
import {
  assertSafeJailPath,
  normalizeJailPaths,
  openStableJailPath,
} from './paths.js';
import {
  assertGrantsNotDangerous,
  assertPathNotRootOrHome,
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
  type SandboxProfile,
} from './types.js';

export async function probeBackends(): Promise<BackendProbe[]> {
  const mxc = await probeMxc();
  return [mxc, ...probeNativeBackends()];
}

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
  const native = createNativeBackend();
  if (native) return native;
  try {
    return await createMxcBackend();
  } catch {
    return undefined;
  }
}

function outcomeEnforced(
  profile: SandboxProfile,
  backendId: SandboxBackendId,
): boolean {
  // Honesty: only package-exec + real backend counts as enforced.
  if (profile !== 'package-exec') return false;
  return backendId !== 'mock' && backendId !== 'off' && backendId !== 'none';
}

/**
 * Run argv inside the sandbox policy.
 */
export async function runInSandbox(
  input: RunInSandboxInput,
): Promise<SandboxOutcome> {
  const profile: SandboxProfile = input.profile ?? 'package-exec';
  const resolved = resolvePolicy(input.policy);
  const policyDigest = await digestSandboxPolicy(input.policy);
  const packageGrants = mergeGrants(
    matchPackageGrant(input.packageId, input.policy.packages),
    input.grants,
  );
  const grantedWrite = normalizeJailPaths(packageGrants.write, 'write grant');
  const grantedRead = normalizeJailPaths(packageGrants.read, 'read grant');
  assertGrantsNotDangerous(grantedWrite, resolved.allowDangerousGrants);
  assertGrantsNotDangerous(grantedRead, resolved.allowDangerousGrants);
  if (profile === 'package-exec') {
    assertSafeJailPath(input.cwd, 'package-exec cwd');
    assertPathNotRootOrHome(
      input.cwd,
      resolved.allowDangerousGrants,
      'package-exec cwd',
    );
    for (const path of input.readwritePaths) {
      assertPathNotRootOrHome(
        path,
        resolved.allowDangerousGrants,
        'package-exec readwrite path',
      );
    }
    for (const path of input.readonlyPaths) {
      assertPathNotRootOrHome(
        path,
        resolved.allowDangerousGrants,
        'package-exec readonly path',
      );
    }
    for (const path of grantedRead) {
      assertPathNotRootOrHome(
        path,
        resolved.allowDangerousGrants,
        'package-exec read grant',
      );
    }
  }
  const network = Boolean(input.network || packageGrants.network);

  if (!resolved.enabled || resolved.mode === 'off') {
    const result = await runAmbient(input, packageGrants.env, resolved);
    return {
      ...result,
      backend: 'off',
      profile: 'ambient',
      enforced: false,
      containmentLimited: true,
      policyDigest,
      degraded: true,
      losses: [
        ...backendLosses('off', 'ambient', false, true),
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
        exitCode: 78,
        stdout: '',
        stderr:
          'openpacker sandbox: no containment backend available (fail-closed)\n',
        backend: 'none',
        profile,
        enforced: false,
        containmentLimited: true,
        policyDigest,
        degraded: false,
        losses: backendLosses('none', profile, false, false),
      };
    }
    const result = await runAmbient(input, packageGrants.env, resolved);
    return {
      ...result,
      backend: 'none',
      profile: 'ambient',
      enforced: false,
      containmentLimited: true,
      policyDigest,
      degraded: true,
      losses: backendLosses('none', 'ambient', false, true),
    };
  }

  const jailRoot = defaultJailHomeRoot();
  await mkdir(jailRoot, { recursive: true });
  const jailHome = await mkdtemp(join(jailRoot, 'home-'));
  const ownedAuthorities: FileHandle[] = [];
  try {
    await mkdir(join(jailHome, 'tmp'), { recursive: true });
    const interpreter = input.argv[0];
    const env = scrubEnvironment({
      ...(input.env === undefined ? {} : { extra: input.env }),
      ...(packageGrants.env === undefined
        ? {}
        : { grantEnv: packageGrants.env }),
      jailHome,
      minimalPath: profile === 'package-exec' && resolved.minimalPath,
      ...(interpreter === undefined ? {} : { interpreter }),
    });
    const hostEnv = scrubEnvironment({
      jailHome,
      minimalPath: true,
    });
    const readwrite = normalizeJailPaths(
      [...input.readwritePaths, jailHome, ...grantedWrite],
      'readwrite path',
    );
    const readonly = normalizeJailPaths(
      [...input.readonlyPaths, ...grantedRead],
      'readonly path',
    );
    const authorities = [...(input.directoryAuthorities ?? [])];
    const authorized = new Set(authorities.map(({ path }) => resolve(path)));
    for (const path of [...readwrite, ...readonly, resolve(input.cwd)]) {
      if (authorized.has(path)) continue;
      const handle = await openStableJailPath(path, 'sandbox bind');
      ownedAuthorities.push(handle);
      authorities.push({ fd: handle.fd, path });
      authorized.add(path);
    }

    const timeoutMs =
      profile === 'package-exec' ? resolved.timeoutMs : resolved.timeoutMs;
    const runOnce = async (active: SandboxBackend) => {
      // Compose timeout with caller signal
      let signal = input.signal;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ac = new AbortController();
      if (timeoutMs > 0) {
        timer = setTimeout(() => ac.abort(), timeoutMs);
        signal =
          input.signal === undefined
            ? ac.signal
            : AbortSignal.any([input.signal, ac.signal]);
      }
      try {
        return await active.run({
          argv: input.argv,
          cwd: input.cwd,
          hostEnv,
          env,
          readwritePaths: readwrite,
          readonlyPaths: readonly,
          network,
          profile,
          legacyFatRoot: resolved.legacyFatRoot,
          maximumStdoutBytes: resolved.maximumStdoutBytes,
          maximumStderrBytes: resolved.maximumStderrBytes,
          maximumOutputBytes: resolved.maximumOutputBytes,
          directoryAuthorities: authorities,
          ...(input.executableAuthority === undefined
            ? {}
            : { executableAuthority: input.executableAuthority }),
          ...(timeoutMs > 0 ? { timeoutMs } : {}),
          ...(signal === undefined ? {} : { signal }),
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    try {
      let active = backend;
      let result = await runOnce(active);

      if (
        result.exitCode !== 0 &&
        active.id === 'mxc' &&
        resolved.prefer === 'auto' &&
        !input.backend
      ) {
        const native = createNativeBackend();
        if (native) {
          active = native;
          result = await runOnce(active);
        }
      }

      const enforced = outcomeEnforced(profile, active.id);
      return {
        ...result,
        backend: active.id,
        profile,
        enforced,
        containmentLimited: profile !== 'package-exec' || !enforced,
        policyDigest,
        degraded: false,
        losses: backendLosses(active.id, profile, enforced, false),
      };
    } catch (error) {
      if (
        error instanceof SandboxBackendError &&
        error.code === 'UNAVAILABLE'
      ) {
        if (
          backend.id === 'mxc' &&
          resolved.prefer === 'auto' &&
          !input.backend
        ) {
          const native = createNativeBackend();
          if (native) {
            const result = await runOnce(native);
            const enforced = outcomeEnforced(profile, native.id);
            return {
              ...result,
              backend: native.id,
              profile,
              enforced,
              containmentLimited: profile !== 'package-exec' || !enforced,
              policyDigest,
              degraded: false,
              losses: backendLosses(native.id, profile, enforced, false),
            };
          }
        }
        if (resolved.mode === 'fail-closed' || resolved.required) {
          return {
            exitCode: 78,
            stdout: '',
            stderr: `openpacker sandbox: ${error.message}\n`,
            backend: 'none',
            profile,
            enforced: false,
            containmentLimited: true,
            policyDigest,
            degraded: false,
            losses: backendLosses('none', profile, false, false),
          };
        }
        const result = await runAmbient(input, packageGrants.env, resolved);
        return {
          ...result,
          backend: 'none',
          profile: 'ambient',
          enforced: false,
          containmentLimited: true,
          policyDigest,
          degraded: true,
          losses: backendLosses('none', 'ambient', false, true),
        };
      }
      throw error;
    }
  } finally {
    await Promise.all(
      ownedAuthorities.map(async (handle) => await handle.close()),
    );
    await rm(jailHome, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runAmbient(
  input: RunInSandboxInput,
  grantEnv: readonly string[] | undefined,
  resolved: ReturnType<typeof resolvePolicy>,
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  outputLimitExceeded?: 'stdout' | 'stderr' | 'combined';
}> {
  if (input.executableAuthority !== undefined)
    throw new SandboxBackendError(
      'UNAVAILABLE',
      'Ambient execution cannot consume stable executable handle authorities',
    );
  const jailRoot = defaultJailHomeRoot();
  await mkdir(jailRoot, { recursive: true });
  const jailHome = await mkdtemp(join(jailRoot, 'ambient-'));
  try {
    await mkdir(join(jailHome, 'tmp'), { recursive: true });
    const env = scrubEnvironment({
      ...(input.env === undefined ? {} : { extra: input.env }),
      ...(grantEnv === undefined ? {} : { grantEnv }),
      jailHome,
      minimalPath: false,
    });
    return await spawnCapture({
      argv: input.argv,
      cwd: input.cwd,
      env,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(resolved.timeoutMs > 0 ? { timeoutMs: resolved.timeoutMs } : {}),
      maximumStdoutBytes: resolved.maximumStdoutBytes,
      maximumStderrBytes: resolved.maximumStderrBytes,
      maximumOutputBytes: resolved.maximumOutputBytes,
    });
  } finally {
    await rm(jailHome, { recursive: true, force: true }).catch(() => undefined);
  }
}

export { createMockBackend };
export type { SandboxBackendId };
