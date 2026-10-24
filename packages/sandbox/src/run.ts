import { type FileHandle } from 'node:fs/promises';
import { createMxcBackend, probeMxc } from './backends/mxc.js';
import {
  createMockBackend,
  assertSnapshot,
  SandboxBackendError,
} from './backends/mock.js';
import { createNativeBackend, probeNativeBackends } from './backends/native.js';
import { defaultJailHomeRoot, scrubEnvironment } from './env.js';
import { boundPaths, pathsToOpen } from './handles.js';
import {
  makeJailHome,
  openJailRoot,
  removeJailHome,
  sweepJailHomesIn,
  type JailHome,
} from './jail-home.js';
import { stoppedByTimeout } from './stop.js';
import { containmentWithdrawnNote } from './platform.js';
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
  matchPackageGrant,
  mergeGrants,
  resolvePolicy,
} from './policy.js';
import {
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

/** `message`, followed on a host without containment by why and what to do. */
function withNote(message: string): string {
  const note = containmentWithdrawnNote();
  return note === undefined ? message : `${message}. ${note}`;
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
  // An executable snapshot is run from its descriptor, which only Linux can
  // do. Refuse before a backend is resolved or a handle opened, with the
  // platform and what to do, rather than after a path that never resolved.
  if (input.executableAuthority !== undefined) assertSnapshot();
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
    // Ambient execution is not a security boundary and this host cannot bound
    // the process tree without a backend, so "off" refuses instead of
    // degrading.
    throw new SandboxBackendError(
      'TREE_CONTAINMENT_UNAVAILABLE',
      'Sandbox disabled by policy, and ambient execution is refused: no OS-owned tree containment is available to bound the process tree',
    );
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
        stderr: `openpacker sandbox: no containment backend available (fail-closed)${withNote('')}\n`,
        backend: 'none',
        profile,
        enforced: false,
        containmentLimited: true,
        policyDigest,
        degraded: false,
        losses: backendLosses('none', profile, false, false),
      };
    }
    // Degrade modes cannot fall back to ambient execution: it is not a
    // security boundary and no owned tree containment exists to bound the
    // process tree.
    throw new SandboxBackendError(
      'TREE_CONTAINMENT_UNAVAILABLE',
      `No containment backend is available, and ambient execution is refused: no OS-owned tree containment is available to bound the process tree${withNote('')}`,
    );
  }

  // A root of this user's that no one else may write, or none (jail-home.ts).
  const jailRoot = await openJailRoot(defaultJailHomeRoot());
  let jail: JailHome;
  try {
    // What runs killed outright left here, judged by their owners.
    await sweepJailHomesIn(jailRoot);
    jail = await makeJailHome(jailRoot);
  } catch (error) {
    await jailRoot.handle.close().catch(() => undefined);
    throw error;
  }
  const jailHome = jail.home;
  const ownedAuthorities: FileHandle[] = [];
  try {
    const interpreter = input.argv[0];
    const env = scrubEnvironment({
      ...(!(input.env === undefined) && { extra: input.env }),
      ...(!(packageGrants.env === undefined) && {
        grantEnv: packageGrants.env,
      }),
      jailHome,
      minimalPath: profile === 'package-exec' && resolved.minimalPath,
      ...(!(interpreter === undefined) && { interpreter }),
      pathPrefix: normalizeJailPaths(input.pathPrefix, 'PATH directory'),
    });
    const hostEnv = scrubEnvironment({
      jailHome,
      minimalPath: true,
    });
    // What `inheritedHandleCount` counts, so a caller can tell in advance.
    const { readwrite, readonly } = boundPaths(input, jailHome);
    const authorities = [...(input.directoryAuthorities ?? [])];
    for (const path of pathsToOpen(input, { readwrite, readonly })) {
      const handle = await openStableJailPath(path, 'sandbox bind');
      ownedAuthorities.push(handle);
      authorities.push({ fd: handle.fd, path });
    }

    const timeoutMs =
      profile === 'package-exec' ? resolved.timeoutMs : resolved.timeoutMs;
    const runOnce = async (active: SandboxBackend) => {
      // Compose timeout with caller signal
      let signal = input.signal;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ac = new AbortController();
      if (timeoutMs > 0) {
        timer = setTimeout(
          () => ac.abort(stoppedByTimeout(timeoutMs)),
          timeoutMs,
        );
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
          ...(!network &&
            !(input.onIsolatedListen === undefined) && {
              onIsolatedListen: input.onIsolatedListen,
            }),
          profile,
          legacyFatRoot: resolved.legacyFatRoot,
          maximumStdoutBytes: resolved.maximumStdoutBytes,
          maximumStderrBytes: resolved.maximumStderrBytes,
          maximumOutputBytes: resolved.maximumOutputBytes,
          directoryAuthorities: authorities,
          ...(!(input.stdin === undefined) && { stdin: input.stdin }),
          ...(!(input.output === undefined) && { output: input.output }),
          ...(!(input.executableAuthority === undefined) && {
            executableAuthority: input.executableAuthority,
          }),
          ...(timeoutMs > 0 && { timeoutMs }),
          ...(!(signal === undefined) && { signal }),
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    try {
      let active = backend;
      let result = await runOnce(active);

      // Output already handed on cannot be taken back, so a run that has
      // shown it is not run again.
      if (
        result.exitCode !== 0 &&
        input.output === undefined &&
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
            stderr: `openpacker sandbox: ${withNote(error.message)}\n`,
            backend: 'none',
            profile,
            enforced: false,
            containmentLimited: true,
            policyDigest,
            degraded: false,
            losses: backendLosses('none', profile, false, false),
          };
        }
        // Degrade modes cannot fall back to ambient execution: it is not a
        // security boundary and no owned tree containment exists to bound the
        // process tree.
        throw new SandboxBackendError(
          'TREE_CONTAINMENT_UNAVAILABLE',
          `${error.message}; ambient execution is refused: no OS-owned tree containment is available to bound the process tree${withNote('')}`,
        );
      }
      throw error;
    }
  } finally {
    await Promise.all(
      ownedAuthorities.map(async (handle) => await handle.close()),
    );
    await removeJailHome(jailRoot, jail);
    await jailRoot.handle.close().catch(() => undefined);
  }
}

export { createMockBackend };
export type { SandboxBackendId };
