/**
 * Delegated adapter plugin host (ADR 0039, spec/prex/v1/delegated-adapter.md).
 *
 * Loads pinned plugins from the user-level store, verifies them, and
 * registers each as a WIT-shaped AdapterModule whose registry-definition and
 * catalog surfaces execute the plugin's immutable store snapshot over the
 * bounded canonical-JSON stdio protocol.
 */

export {
  registerInstalledPlugins,
  type PluginRefusal,
  type RegisterInstalledPluginsOptions,
  type RegisterInstalledPluginsResult,
} from './register.js';
export {
  DelegatedPluginExecutor,
  DEFAULT_PLUGIN_LIMITS,
  type DelegatedPluginExecutorDependencies,
  type DelegatedPluginInvocation,
  type DelegatedPluginLimits,
  type SandboxRun,
} from './executor.js';
export {
  admitsOperation,
  loadPluginManifest,
  CATALOG_OPERATIONS,
  DELEGATED_ADAPTER_MANIFEST_SCHEMA,
  DELEGATED_ADAPTER_RESPONSE_SCHEMA,
} from './manifest.js';
export {
  buildRequestBytes,
  parsePluginResponse,
  validateOperationResult,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
} from './protocol.js';
export { delegatedAdapterModule } from './module.js';
