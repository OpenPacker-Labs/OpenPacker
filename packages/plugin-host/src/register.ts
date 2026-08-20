import {
  AdapterHostError,
  getAdapterRegistry,
  type AdapterRegistry,
} from '@openpacker/adapter-host';
import type { DelegatedAdapterManifest } from '@openpacker/contracts';
import { OpmError } from '@openpacker/opm-project';
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

/**
 * Load every pinned plugin from the user-level store and register it.
 *
 * Per plugin, before anything executes: the store entry's tree digest is
 * re-verified against the pin, the manifest is re-read no-follow and
 * schema-validated, capabilities and commands must agree, and a plugin whose
 * purl types collide with an already-registered adapter is refused — a
 * first-party adapter always wins over a plugin, never the reverse.
 */
export async function registerInstalledPlugins(
  options: RegisterInstalledPluginsOptions = {},
): Promise<RegisterInstalledPluginsResult> {
  const registry = options.registry ?? getAdapterRegistry();
  const storeRoot = options.storeRoot ?? pluginStoreRoot();
  // A store that was never created means no plugins; registration must not
  // create it — this runs at CLI startup, before any plugin command.
  const rootInfo = await lstat(storeRoot).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (rootInfo === undefined) return { registered: [], refused: [] };
  const listed = await listPlugins({ storeRoot });
  const registered: string[] = [];
  const refused: PluginRefusal[] = [];
  for (const plugin of listed) {
    try {
      const manifest = await loadVerifiedManifest(plugin, storeRoot);
      assertNoConflict(registry, plugin, manifest);
      const executor = new DelegatedPluginExecutor(
        manifest,
        plugin.storePath,
        resolveEnvironment(manifest, options),
        dependencies(options),
      );
      registry.register(
        delegatedAdapterModule(manifest, executor, {
          ...(options.now === undefined ? {} : { now: options.now }),
        }),
      );
      registered.push(manifest.id);
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
): Promise<DelegatedAdapterManifest> {
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
  return manifest;
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
function resolveEnvironment(
  manifest: DelegatedAdapterManifest,
  options: RegisterInstalledPluginsOptions,
): {
  environment: Readonly<Record<string, string>>;
  grantedEnvironment: readonly string[];
  allowNetwork: boolean;
} {
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
    ...(options.sandboxRun === undefined
      ? {}
      : { sandboxRun: options.sandboxRun }),
    ...(options.inspectExecutable === undefined
      ? {}
      : { inspectExecutable: options.inspectExecutable }),
    ...(options.openExecutableAuthority === undefined
      ? {}
      : { openExecutableAuthority: options.openExecutableAuthority }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.sandboxPrefer === undefined
      ? {}
      : { sandboxPrefer: options.sandboxPrefer }),
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
