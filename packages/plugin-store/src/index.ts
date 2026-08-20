/**
 * User-level delegated adapter plugin store (`pkg:opm-plugin/*`).
 * See ADR 0039 and spec/prex/v1/delegated-adapter.md.
 */

export {
  addPlugin,
  listPlugins,
  parsePluginName,
  parsePluginSpec,
  pluginStoreRoot,
  removePlugin,
  verifiedPluginEntry,
  PLUGIN_INDEX_NAME,
  PLUGIN_MANIFEST_NAME,
  type AddPluginOptions,
  type InstalledPlugin,
  type ListedPlugin,
  type PluginPin,
  type PluginSpec,
  type PluginStoreOptions,
} from './store.js';

export {
  MAX_PLUGIN_ARTIFACT_BYTES,
  PLUGIN_PURL_TYPE,
  PLUGIN_REGISTRY_ENDPOINT_ENV,
  pluginRegistryEndpoint,
  pluginRegistryModule,
  PluginRegistryProvider,
  requirePluginRegistryEndpoint,
  type PluginRegistryModuleOptions,
} from './registry.js';
