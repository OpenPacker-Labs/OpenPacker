import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  AdapterHostError,
  getAdapterRegistry,
  type AdapterRegistry,
} from '@openpacker/adapter-host';
import type { DelegatedAdapterManifest } from '@openpacker/contracts';
import { OpmError, readStableFileBytes } from '@openpacker/opm-project';
import { MAX_DELEGATED_EXECUTABLE_BYTES } from '@openpacker/pack-provider';
import {
  listPlugins,
  pluginStoreRoot,
  verifiedPluginEntry,
  PLUGIN_PURL_TYPE,
  type ListedPlugin,
} from '@openpacker/plugin-store';
import { lstat } from 'node:fs/promises';
import {
  DelegatedPluginExecutor,
  type DelegatedPluginExecutorDependencies,
} from './executor.js';
import { loadPluginManifest } from './manifest.js';
import { delegatedAdapterModule } from './module.js';

export interface RegisterInstalledPluginsOptions
  extends DelegatedPluginExecutorDependencies {
  /** Plugin store root override; defaults to OPM_PLUGIN_HOME / XDG. */
  storeRoot?: string;
  /** Registry to register into; defaults to the process-wide host registry. */
  registry?: AdapterRegistry;
  /**
   * Operator-allowlisted environment names. A manifest-declared environment
   * entry (static value or `authority.environment` name) is forwarded only
   * when its name appears here — ambient process.env is not consent.
   */
  allowEnvironment?: readonly string[];
  /**
   * Source of operator-granted environment values (e.g. explicit CLI
   * --allow-env picks). Never defaults to process.env.
   */
  environment?: Readonly<Record<string, string | undefined>>;
  /**
   * Env-var names host-fetch may read for this run (toml token and
   * extra-header envs). `--allow-env` of these names is refused; grant
   * does not win.
   */
  hostFetchTokenEnvNames?: readonly string[];
  /** Operator network consent; still denied per-operation in offline mode. */
  allowNetwork?: boolean;
  /** Injectable clock for adapter contexts. */
  now?: () => string;
}

export interface PluginRefusal {
  /** Store index key (`opm plugin add <name>`). */
  name: string;
  code: string;
  message: string;
}

export interface RegisterInstalledPluginsResult {
  /** Manifest ids of plugins now answering in the registry. */
  registered: readonly string[];
  /**
   * Plugins that failed verification, consistency, or conflict checks. A
   * refused plugin is simply absent from the registry, so any operation that
   * needed it fails closed; refusing must never take the host down with it.
   */
  refused: readonly PluginRefusal[];
}

/** A plugin made available in an adapter registry by this host. */
export interface RegisteredPlugin {
  /** Store index key (`opm plugin add <name>`). */
  name: string;
  /** Manifest id — the key project bindings (`[plugins.<id>]`) use. */
  id: string;
  /** Purl types the plugin serves. */
  purlTypes: readonly string[];
  /** True when the plugin was already registered (idempotent re-entry). */
  alreadyRegistered: boolean;
}

/**
 * Register one named, already-installed plugin. Never acquires: a name the
 * store does not pin is PLUGIN_NOT_INSTALLED, a tampered entry fails closed at
 * digest verification. Re-registering the same plugin is a no-op, so a caller
 * (opmx, a project binding) can ensure registration without coordinating with
 * startup registration.
 */
export async function registerPlugin(
  name: string,
  options: RegisterInstalledPluginsOptions = {},
): Promise<RegisteredPlugin> {
  const storeRoot = options.storeRoot ?? pluginStoreRoot();
  const listed = await listPlugins({ storeRoot });
  const plugin = listed.find((entry) => entry.name === name);
  if (plugin === undefined)
    throw new OpmError(
      'PLUGIN_NOT_INSTALLED',
      `Plugin "${name}" is not installed. Install it first: opm plugin add ${name}`,
    );
  return registerOne(plugin, storeRoot, options);
}

/**
 * Verify and register a project's `[plugins.<id>]` bindings.
 *
 * Each binding key is a manifest id, and `storeDigest` pins the exact
 * content-addressed store entry (spec/prex/v1/delegated-adapter.md §Binding).
 * A binding never triggers acquisition: an uninstalled id is
 * PLUGIN_NOT_INSTALLED, a different installed store digest is
 * PLUGIN_DIGEST_MISMATCH, and the entry's materialized bytes are re-verified
 * against the pin before registration.
 */
export async function verifyPluginBindings(
  bindings: Readonly<
    Record<
      string,
      {
        storeDigest: string;
        artifactOriginTokenEnvs?: readonly string[];
        artifactOriginExtraHeaderEnvs?: readonly string[];
      }
    >
  >,
  options: RegisterInstalledPluginsOptions = {},
): Promise<readonly RegisteredPlugin[]> {
  const storeRoot = options.storeRoot ?? pluginStoreRoot();
  const listed = await listPlugins({ storeRoot });
  const registered: RegisteredPlugin[] = [];
  const tokenNames = Object.values(bindings).flatMap((binding) => [
    ...(binding.artifactOriginTokenEnvs ?? []),
    ...(binding.artifactOriginExtraHeaderEnvs ?? []),
  ]);
  const withTokenNames =
    tokenNames.length === 0
      ? options
      : {
          ...options,
          hostFetchTokenEnvNames: [
            ...(options.hostFetchTokenEnvNames ?? []),
            ...tokenNames,
          ],
        };
  for (const [id, binding] of Object.entries(bindings)) {
    const plugin = listed.find((entry) => entry.id === id);
    if (plugin === undefined)
      throw new OpmError(
        'PLUGIN_NOT_INSTALLED',
        `Project binds plugin "${id}", which is not installed. ` +
          'A binding never acquires: install it first with `opm plugin add`.',
      );
    if (plugin.storeDigest !== binding.storeDigest)
      throw new OpmError(
        'PLUGIN_DIGEST_MISMATCH',
        `Project binds plugin "${id}" to store entry ${binding.storeDigest}, ` +
          `but the installed entry is ${plugin.storeDigest}. ` +
          'Re-pin the project or reinstall the pinned plugin; the binding is refused.',
      );
    registered.push(await registerOne(plugin, storeRoot, withTokenNames));
  }
  return registered;
}

/**
 * Verify one pinned plugin and register it, unless its manifest id already
 * answers in the registry (startup registration beat us to it).
 */
async function registerOne(
  plugin: ListedPlugin,
  storeRoot: string,
  options: RegisterInstalledPluginsOptions,
): Promise<RegisteredPlugin> {
  const registry = options.registry ?? getAdapterRegistry();
  const { manifest, executableDigest } = await loadVerifiedManifest(
    plugin,
    storeRoot,
  );
  if (registry.list().some((module) => module.id === manifest.id))
    return {
      name: plugin.name,
      id: manifest.id,
      purlTypes: [...manifest.purlTypes],
      alreadyRegistered: true,
    };
  assertNoConflict(registry, plugin, manifest);
  const executor = new DelegatedPluginExecutor(
    manifest,
    plugin.storePath,
    { ...resolveEnvironment(manifest, options), executableDigest },
    dependencies(options),
  );
  registry.register(
    delegatedAdapterModule(manifest, executor, {
      ...(!(options.now === undefined) && { now: options.now }),
    }),
  );
  return {
    name: plugin.name,
    id: manifest.id,
    purlTypes: [...manifest.purlTypes],
    alreadyRegistered: false,
  };
}

/**
 * Load every pinned plugin from the user-level store and register it.
 *
 * Per plugin, before anything executes: the store entry's tree digest is
 * re-verified against the pin, the manifest is re-read no-follow and
 * schema-validated, the verified executable's digest is pinned for every
 * later invocation to re-assert, capabilities and commands must agree, and a
 * plugin whose purl types collide with an already-registered adapter is
 * refused — a first-party adapter always wins over a plugin, never the
 * reverse.
 */
export async function registerInstalledPlugins(
  options: RegisterInstalledPluginsOptions = {},
): Promise<RegisterInstalledPluginsResult> {
  const storeRoot = options.storeRoot ?? pluginStoreRoot();
  // A store that was never created means no plugins; registration must not
  // create it — this runs at CLI startup, before any plugin command.
  const rootInfo = await lstat(storeRoot).catch((error: unknown) => {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (rootInfo === undefined) return { registered: [], refused: [] };
  const listed = await listPlugins({ storeRoot });
  const registered: string[] = [];
  const refused: PluginRefusal[] = [];
  for (const plugin of listed) {
    try {
      const entry = await registerOne(plugin, storeRoot, options);
      if (!entry.alreadyRegistered) registered.push(entry.id);
    } catch (error) {
      refused.push({
        name: plugin.name,
        code: codeOf(error),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { registered, refused };
}

async function loadVerifiedManifest(
  plugin: ListedPlugin,
  storeRoot: string,
): Promise<{ manifest: DelegatedAdapterManifest; executableDigest: string }> {
  const storePath = await verifiedPluginEntry(plugin, { storeRoot });
  const manifest = await loadPluginManifest(storePath, plugin.manifestPath);
  if (manifest.id !== plugin.id)
    throw new OpmError(
      'INVALID_PLUGIN_MANIFEST',
      `Plugin "${plugin.name}" pinned id ${plugin.id} but its manifest now says ${manifest.id}`,
    );
  if (
    manifest.purlTypes.some((type) => type.toLowerCase() === PLUGIN_PURL_TYPE)
  )
    throw new OpmError(
      'INVALID_PLUGIN_MANIFEST',
      `Plugin "${plugin.name}" claims the reserved ${PLUGIN_PURL_TYPE} purl type`,
    );
  // Pin the verified executable's digest: the tree was just re-verified
  // against the pin, so this no-follow read hashes approved bytes, and the
  // executor re-asserts this digest against every invocation-time snapshot.
  const executableBytes = await readStableFileBytes(
    join(storePath, manifest.executable),
    MAX_DELEGATED_EXECUTABLE_BYTES,
  );
  const executableDigest = createHash('sha256')
    .update(executableBytes)
    .digest('hex');
  return { manifest, executableDigest };
}

/**
 * First-party wins: a plugin never displaces an adapter that is already
 * registered for a purl type or under its id, and a second plugin claiming a
 * type the first one took is refused the same way.
 */
function assertNoConflict(
  registry: AdapterRegistry,
  plugin: ListedPlugin,
  manifest: DelegatedAdapterManifest,
): void {
  if (registry.list().some((module) => module.id === manifest.id))
    throw new AdapterHostError(
      'PLUGIN_CONFLICT',
      `Plugin "${plugin.name}" id ${manifest.id} is already registered`,
    );
  for (const purlType of manifest.purlTypes)
    if (registry.has(purlType))
      throw new AdapterHostError(
        'PLUGIN_CONFLICT',
        `Plugin "${plugin.name}" declares purl type ${purlType}, which is ` +
          'already served by a registered adapter; the existing adapter wins ' +
          'and the plugin is refused',
      );
}

/**
 * The environment a plugin invocation may see: manifest-declared entries
 * whose names the operator allowlisted. Static manifest values are literals
 * (never secrets per spec); authority.environment names take their value from
 * the operator-granted map and are additionally granted to the sandbox
 * scrubber, mirroring configurePackProviders.
 */
function hostFetchDeniedEnvNames(
  options: RegisterInstalledPluginsOptions,
): Set<string> {
  const denied = new Set<string>();
  for (const name of options.hostFetchTokenEnvNames ?? []) {
    if (name !== '') denied.add(name);
  }
  for (const raw of [
    process.env.OPM_HOST_FETCH_TOKEN_ENVS,
    process.env.OPM_HOST_FETCH_HEADER_ENVS,
  ]) {
    if (raw !== undefined && raw.trim() !== '') {
      for (const name of raw.split(',').map((part) => part.trim())) {
        if (name !== '') denied.add(name);
      }
    }
  }
  return denied;
}

function assertAllowEnvironmentSafe(
  options: RegisterInstalledPluginsOptions,
): void {
  const denied = hostFetchDeniedEnvNames(options);
  for (const name of options.allowEnvironment ?? []) {
    if (name.startsWith('OPM_HOST_FETCH_') || denied.has(name))
      throw new OpmError(
        'UNSAFE_ENV',
        `--allow-env ${name} is a host-fetch credential and cannot be granted to a plugin`,
      );
  }
}

function resolveEnvironment(
  manifest: DelegatedAdapterManifest,
  options: RegisterInstalledPluginsOptions,
) {
  assertAllowEnvironmentSafe(options);
  const allowlist = new Set(options.allowEnvironment ?? []);
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(manifest.environment ?? {}))
    if (allowlist.has(name)) environment[name] = value;
  const granted: string[] = [];
  for (const name of manifest.authority.environment) {
    if (!allowlist.has(name)) continue;
    const value = options.environment?.[name];
    if (value === undefined) continue;
    environment[name] = value;
    granted.push(name);
  }
  return {
    environment,
    grantedEnvironment: granted,
    allowNetwork: options.allowNetwork === true,
  };
}

function dependencies(
  options: RegisterInstalledPluginsOptions,
): DelegatedPluginExecutorDependencies {
  return {
    ...(!(options.sandboxRun === undefined) && {
      sandboxRun: options.sandboxRun,
    }),
    ...(!(options.inspectExecutable === undefined) && {
      inspectExecutable: options.inspectExecutable,
    }),
    ...(!(options.openExecutableAuthority === undefined) && {
      openExecutableAuthority: options.openExecutableAuthority,
    }),
    ...(!(options.limits === undefined) && { limits: options.limits }),
    ...(!(options.sandboxPrefer === undefined) && {
      sandboxPrefer: options.sandboxPrefer,
    }),
  };
}

function codeOf(error: unknown): string {
  if (error instanceof OpmError || error instanceof AdapterHostError)
    return error.code;
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string'
  )
    return error.code;
  return 'PLUGIN_LOAD_FAILED';
}
