import { join } from 'node:path';
import { ProviderError } from '@openpacker/adapter-core';
import type { AdapterContext } from '@openpacker/adapter-host';
import type {
  DelegatedAdapterManifest,
  DelegatedAdapterOperation,
  DelegatedAdapterRequest,
  JsonValue,
} from '@openpacker/contracts';
import {
  assertExecutableIdentity,
  inspectDelegatedExecutable,
  openDelegatedExecutable,
  type InspectDelegatedExecutable,
  type OpenDelegatedExecutableAuthority,
} from '@openpacker/pack-provider';
import {
  runInSandbox,
  SandboxBackendError,
  type RunInSandboxInput,
  type SandboxOutcome,
  type SandboxPrefer,
} from '@openpacker/sandbox';
import { admitsOperation } from './manifest.js';
import {
  buildRequestBytes,
  parsePluginResponse,
  validateOperationResult,
  MAX_RESPONSE_BYTES,
} from './protocol.js';

export type SandboxRun = (input: RunInSandboxInput) => Promise<SandboxOutcome>;

export interface DelegatedPluginLimits {
  /** Wall-clock budget for one plugin operation. */
  timeoutMs: number;
  /** stdout budget; the response document must fit. */
  responseBytes: number;
  /** stderr budget (diagnostics only, never parsed). */
  stderrBytes: number;
}

export const DEFAULT_PLUGIN_LIMITS: DelegatedPluginLimits = {
  timeoutMs: 30_000,
  responseBytes: MAX_RESPONSE_BYTES,
  stderrBytes: 262_144,
};

// Sandbox policy ceilings (packages/sandbox/src/policy.ts): budgets larger
// than these are rejected, so plugin limits clamp into them.
const SANDBOX_CHANNEL_CEILING = 1_048_576;
const SANDBOX_COMBINED_CEILING = 2_097_152;

function clampedLimits(limits: DelegatedPluginLimits): {
  stdout: number;
  stderr: number;
  combined: number;
  response: number;
} {
  const stdout = Math.min(limits.responseBytes, SANDBOX_CHANNEL_CEILING);
  const stderr = Math.min(limits.stderrBytes, SANDBOX_CHANNEL_CEILING);
  return {
    stdout,
    stderr,
    combined: Math.min(stdout + stderr, SANDBOX_COMBINED_CEILING),
    response: stdout,
  };
}

export interface DelegatedPluginExecutorDependencies {
  sandboxRun?: SandboxRun;
  inspectExecutable?: InspectDelegatedExecutable;
  openExecutableAuthority?: OpenDelegatedExecutableAuthority;
  limits?: Partial<DelegatedPluginLimits>;
  sandboxPrefer?: SandboxPrefer;
}

export interface DelegatedPluginInvocation {
  operation: DelegatedAdapterOperation;
  params: DelegatedAdapterRequest['params'];
  context: AdapterContext;
  signal?: AbortSignal;
}

/**
 * Executes one verified store plugin per spec/prex/v1/delegated-adapter.md:
 * only the immutable snapshot of the approved store executable runs, inside
 * the fail-closed sandbox, with the request on stdin and no ambient network
 * unless the operator consented and the manifest requested it.
 */
export class DelegatedPluginExecutor {
  readonly #manifest: DelegatedAdapterManifest;
  readonly #storePath: string;
  readonly #executableDigest: string;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #grantedEnvironment: readonly string[];
  readonly #allowNetwork: boolean;
  readonly #sandboxRun: SandboxRun;
  readonly #inspectExecutable: InspectDelegatedExecutable;
  readonly #openExecutableAuthority: OpenDelegatedExecutableAuthority;
  readonly #limits: DelegatedPluginLimits;
  readonly #sandboxPrefer: SandboxPrefer;

  constructor(
    manifest: DelegatedAdapterManifest,
    storePath: string,
    options: {
      /** Static + operator-authorized environment, already allowlist-filtered. */
      environment: Readonly<Record<string, string>>;
      /** Names whose values came from the operator (granted to the scrubber). */
      grantedEnvironment: readonly string[];
      allowNetwork: boolean;
      /**
       * sha256 hex of the store executable as verified at registration.
       * Re-asserted against the invocation-time snapshot before every run, so
       * a store entry swapped after registration fails closed instead of
       * executing bytes the operator never approved.
       */
      executableDigest: string;
    },
    dependencies: DelegatedPluginExecutorDependencies = {},
  ) {
    this.#manifest = manifest;
    this.#storePath = storePath;
    this.#executableDigest = options.executableDigest;
    this.#environment = options.environment;
    this.#grantedEnvironment = options.grantedEnvironment;
    this.#allowNetwork = options.allowNetwork;
    this.#sandboxRun = dependencies.sandboxRun ?? runInSandbox;
    this.#inspectExecutable =
      dependencies.inspectExecutable ?? inspectDelegatedExecutable;
    this.#openExecutableAuthority =
      dependencies.openExecutableAuthority ??
      (dependencies.inspectExecutable === undefined
        ? openDelegatedExecutable
        : async (path) => ({
            identity: await dependencies.inspectExecutable!(path),
            fd: -1,
            close: async () => undefined,
          }));
    this.#limits = { ...DEFAULT_PLUGIN_LIMITS, ...dependencies.limits };
    this.#sandboxPrefer = dependencies.sandboxPrefer ?? 'auto';
  }

  get executablePath(): string {
    // The manifest executable name is a schema-bounded single segment, and
    // the store pinned exactly this file at add time.
    return join(this.#storePath, this.#manifest.executable);
  }

  /**
   * Invoke one operation and return its validated result payload.
   *
   * Failure is always a ProviderError: OFFLINE before any execution, an
   * undeclared operation is UNSUPPORTED_OPERATION, a plugin-reported error is
   * PLUGIN_ERROR, a sandbox backend that cannot run the plugin is
   * UNAVAILABLE, an unexpected execution failure is PLUGIN_FAILED, a store
   * executable whose digest drifted since registration is
   * AUTHORITY_NOT_DECLARED, and anything malformed, oversized, swapped, or
   * schema-invalid is INVALID_RESPONSE.
   */
  async invoke(input: DelegatedPluginInvocation): Promise<unknown> {
    const { operation } = input;
    const manifest = this.#manifest;
    const offline = input.context.offline === true;
    if (offline)
      throw new ProviderError(
        'OFFLINE',
        `Plugin ${manifest.id} is never invoked in offline mode; it gets no ambient network, so its answer would be indistinguishable from staleness`,
      );
    if (!admitsOperation(manifest, operation))
      throw new ProviderError(
        'UNSUPPORTED_OPERATION',
        `Plugin ${manifest.id} does not declare the ${operation} operation`,
      );
    const command = manifest.commands[operation]!;
    const requestBytes = buildRequestBytes(operation, {
      ...input.params,
      offline,
    });

    const authority = await this.#openExecutableAuthority(
      this.executablePath,
    ).catch((error: unknown) => {
      throw new ProviderError(
        'AUTHORITY_NOT_DECLARED',
        `Plugin ${manifest.id} executable is not a stable approved file: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    try {
      // Registration pinned the executable's digest; refuse to run anything
      // the snapshot authority no longer recognizes as those bytes.
      if (authority.identity.digest.value !== this.#executableDigest)
        throw new ProviderError(
          'AUTHORITY_NOT_DECLARED',
          `Plugin ${manifest.id} executable no longer hashes to the digest verified at registration; the store entry drifted, repair it with \`opm plugin remove\` and \`opm plugin add\``,
        );
      const network =
        manifest.authority.network === 'consent' &&
        this.#allowNetwork &&
        !offline;
      const outcome = await this.runSnapshot(
        authority.identity.path,
        authority,
        command.arguments,
        requestBytes,
        network,
        input.signal,
      ).catch((error: unknown) => {
        if (error instanceof ProviderError) throw error;
        throw sandboxFailure(manifest.id, operation, error);
      });
      if (outcome.outputLimitExceeded !== undefined)
        throw new ProviderError(
          'INVALID_RESPONSE',
          `Plugin ${manifest.id} ${operation} exceeded its ${outcome.outputLimitExceeded} output budget`,
        );
      if (outcome.exitCode !== 0)
        throw new ProviderError(
          'PLUGIN_FAILED',
          `Plugin ${manifest.id} ${operation} exited ${outcome.exitCode}${
            outcome.stderr === '' ? '' : `: ${outcome.stderr.slice(0, 2048)}`
          }`,
        );
      const response = parsePluginResponse(
        manifest.id,
        outcome.stdout,
        clampedLimits(this.#limits).response,
      );
      if (!response.ok) {
        const error = response.error!;
        throw new ProviderError(
          'PLUGIN_ERROR',
          `Plugin ${manifest.id} ${operation} failed: ${error.code}: ${error.message}`,
        );
      }
      return validateOperationResult(
        manifest,
        operation,
        response.result!,
        input.params,
      );
    } finally {
      // Closing the snapshot fd is best-effort cleanup: a raw fs error here
      // must not escape as an untyped failure or mask an in-flight one.
      await authority.close().catch(() => undefined);
    }
  }

  private async runSnapshot(
    executablePath: string,
    authority: Awaited<ReturnType<OpenDelegatedExecutableAuthority>>,
    arguments_: readonly string[],
    requestBytes: Uint8Array,
    network: boolean,
    signal: AbortSignal | undefined,
  ): Promise<SandboxOutcome> {
    const budget = clampedLimits(this.#limits);
    await assertExecutableIdentity(
      authority.identity,
      await this.#inspectExecutable(authority.identity.path),
    );
    const outcome = await this.#sandboxRun({
      argv: [executablePath, ...arguments_],
      cwd: this.#storePath,
      env: this.#environment,
      stdin: requestBytes,
      grants: { env: this.#grantedEnvironment },
      policy: {
        enabled: true,
        required: true,
        mode: 'fail-closed',
        prefer: this.#sandboxPrefer,
        timeoutMs: this.#limits.timeoutMs,
        maximumStdoutBytes: budget.stdout,
        maximumStderrBytes: budget.stderr,
        maximumOutputBytes: budget.combined,
      },
      readwritePaths: [],
      readonlyPaths: [this.#storePath],
      network,
      profile: 'package-exec',
      ...(authority.fd < 0
        ? {}
        : {
            executableAuthority: {
              fd: authority.fd,
              path: authority.identity.path,
            },
          }),
      ...(signal === undefined ? {} : { signal }),
    });
    await assertExecutableIdentity(
      authority.identity,
      await this.#inspectExecutable(authority.identity.path),
    );
    return outcome;
  }
}

/**
 * A thrown sandbox run is host-side infrastructure failing, not a plugin
 * answer: backend/containment unavailability maps to UNAVAILABLE, anything
 * else unexpected to PLUGIN_FAILED. ProviderErrors (identity re-checks) pass
 * through untouched by the caller.
 */
function sandboxFailure(
  pluginId: string,
  operation: DelegatedAdapterOperation,
  error: unknown,
): ProviderError {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof SandboxBackendError)
    return new ProviderError(
      'UNAVAILABLE',
      `Plugin ${pluginId} ${operation} cannot run: sandbox ${error.code}: ${detail}`,
    );
  return new ProviderError(
    'PLUGIN_FAILED',
    `Plugin ${pluginId} ${operation} sandbox run failed: ${detail}`,
  );
}
