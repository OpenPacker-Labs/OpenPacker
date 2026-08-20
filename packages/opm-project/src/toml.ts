import type { PolicyInput } from '@openpacker/contracts';
import type {
  NativeProjectionLevel,
  OpmManifest,
  PackProviderSource,
  PackageRequirement,
  PluginBinding,
  RegistrySource,
  RequirementScope,
} from './types.js';
import { OpmError } from './types.js';
import { assertDigest } from './paths.js';
import { defaultSupplyChainPolicyInput } from './supply-chain.js';

/**
 * Minimal TOML subset reader/writer for opm.toml.
 * Supports: [section], string/bool/number/array-of-string.
 * [policy] holds committed supply-chain governance (no secret expansion).
 */

export function defaultManifest(name = 'project'): OpmManifest {
  return {
    project: {
      name,
      ecosystems: ['npm', 'cargo', 'pypi'],
    },
    packages: {},
    options: {
      offline: false,
      layout: 'opm',
    },
    // Configured recommended production profile (ADR 0033). Scripts stay off.
    policy: defaultSupplyChainPolicyInput(),
  };
}

export function serializeManifest(manifest: OpmManifest): string {
  const lines: string[] = [
    '# Open Package Manager project manifest',
    '[project]',
    `name = ${tomlString(manifest.project.name)}`,
    `ecosystems = ${tomlStringArray(manifest.project.ecosystems)}`,
    '',
  ];

  const aliases = Object.keys(manifest.packages).sort();
  if (aliases.length === 0) {
    lines.push('# [packages.<alias>]');
    lines.push('# purl = "pkg:npm/example"');
    lines.push('# version = "1.0.0"');
    lines.push('');
  } else {
    for (const alias of aliases) {
      const pkg = manifest.packages[alias];
      if (!pkg) continue;
      lines.push(`[packages.${escapeKey(alias)}]`);
      lines.push(`purl = ${tomlString(pkg.purl)}`);
      if (pkg.version !== undefined)
        lines.push(`version = ${tomlString(pkg.version)}`);
      if (pkg.source !== undefined)
        lines.push(`source = ${tomlString(pkg.source)}`);
      if (pkg.scope !== undefined && pkg.scope !== 'runtime')
        lines.push(`scope = ${tomlString(pkg.scope)}`);
      if (pkg.bins !== undefined && pkg.bins.length > 0) {
        // bins expressed as parallel arrays for simple TOML subset
        lines.push(
          `bin_names = ${tomlStringArray(pkg.bins.map((b) => b.name))}`,
        );
        lines.push(
          `bin_paths = ${tomlStringArray(pkg.bins.map((b) => b.path))}`,
        );
      }
      lines.push('');
    }
  }

  for (const id of Object.keys(manifest.registries ?? {}).sort()) {
    const source = manifest.registries![id]!;
    lines.push(`[registries.${escapeKey(id)}]`);
    lines.push(`url = ${tomlString(source.url)}`);
    if (source.defaultFor !== undefined && source.defaultFor.length > 0)
      lines.push(`default_for = ${tomlStringArray(source.defaultFor)}`);
    lines.push('');
  }

  for (const id of Object.keys(manifest.packProviders ?? {}).sort()) {
    const provider = manifest.packProviders![id]!;
    lines.push(`[pack.providers.${packProviderKey(id)}]`);
    lines.push(`manifest = ${tomlString(provider.manifest)}`);
    lines.push(`executable = ${tomlString(provider.executable)}`);
    if (provider.defaultFor !== undefined && provider.defaultFor.length > 0)
      lines.push(`default_for = ${tomlStringArray(provider.defaultFor)}`);
    if (
      provider.allowEnvironment !== undefined &&
      provider.allowEnvironment.length > 0
    )
      lines.push(
        `allow_environment = ${tomlStringArray(provider.allowEnvironment)}`,
      );
    lines.push('');
  }

  for (const id of Object.keys(manifest.plugins ?? {}).sort()) {
    const binding = manifest.plugins![id]!;
    lines.push(`[plugins.${id}]`);
    lines.push(`store_digest = ${tomlString(binding.storeDigest)}`);
    lines.push('');
  }

  lines.push('[options]');
  lines.push(`offline = ${manifest.options.offline ? 'true' : 'false'}`);
  lines.push(`layout = ${tomlString(manifest.options.layout)}`);
  if (manifest.options.nativeProjection !== undefined)
    lines.push(
      `native_projection = ${tomlString(manifest.options.nativeProjection)}`,
    );
  lines.push('');

  if (manifest.policy) {
    lines.push(
      '# Supply-chain / PREX policy (committed; no secrets in registry URLs)',
    );
    lines.push('[policy]');
    const policy = manifest.policy;
    lines.push(`allow_yanked = ${policy.allowYanked ? 'true' : 'false'}`);
    lines.push(
      `allow_quarantined = ${policy.allowQuarantined ? 'true' : 'false'}`,
    );
    lines.push(
      `semantic_loss_maximum = ${tomlString(policy.semanticLossMaximum)}`,
    );
    if (policy.requiredEvidence.length > 0)
      lines.push(
        `required_evidence = ${tomlStringArray(policy.requiredEvidence)}`,
      );
    if (policy.minimumReleaseAgeMinutes !== undefined)
      lines.push(
        `minimum_release_age_minutes = ${policy.minimumReleaseAgeMinutes}`,
      );
    if (policy.minimumReleaseAgeStrict !== undefined)
      lines.push(
        `minimum_release_age_strict = ${policy.minimumReleaseAgeStrict ? 'true' : 'false'}`,
      );
    if (policy.minimumReleaseAgeExclude?.length)
      lines.push(
        `minimum_release_age_exclude = ${tomlStringArray(policy.minimumReleaseAgeExclude)}`,
      );
    if (policy.trustPolicy !== undefined)
      lines.push(`trust_policy = ${tomlString(policy.trustPolicy)}`);
    if (policy.trustPolicyExclude?.length)
      lines.push(
        `trust_policy_exclude = ${tomlStringArray(policy.trustPolicyExclude)}`,
      );
    if (policy.blockExoticSources?.transitive !== undefined)
      lines.push(
        `block_exotic_transitive = ${policy.blockExoticSources.transitive ? 'true' : 'false'}`,
      );
    if (policy.blockExoticSources?.direct !== undefined)
      lines.push(
        `block_exotic_direct = ${policy.blockExoticSources.direct ? 'true' : 'false'}`,
      );
    if (policy.allowLifecycleScripts !== undefined)
      lines.push(
        `allow_lifecycle_scripts = ${policy.allowLifecycleScripts ? 'true' : 'false'}`,
      );
    if (policy.allowedLifecycleScriptPackages?.length)
      lines.push(
        `allowed_lifecycle_script_packages = ${tomlStringArray(policy.allowedLifecycleScriptPackages)}`,
      );
    if (policy.expectedRegistryId !== undefined)
      lines.push(
        `expected_registry_id = ${tomlString(policy.expectedRegistryId)}`,
      );
    lines.push('');
  }

  const pePreview = manifest.policy as
    | (PolicyInput & {
        projectWrite?: boolean;
        minimalPath?: boolean;
        strictLifecycleAllowlist?: boolean;
        allowDangerousGrants?: boolean;
        legacyFatRoot?: boolean;
        timeoutMs?: number;
      })
    | undefined;
  if (
    manifest.policy?.sandboxMode !== undefined ||
    manifest.policy?.sandboxPrefer !== undefined ||
    manifest.policy?.sandboxRequired !== undefined ||
    manifest.policy?.allowHostUnsandboxedInstall !== undefined ||
    pePreview?.projectWrite !== undefined ||
    pePreview?.minimalPath !== undefined ||
    pePreview?.strictLifecycleAllowlist !== undefined ||
    pePreview?.allowDangerousGrants !== undefined ||
    pePreview?.legacyFatRoot !== undefined ||
    pePreview?.timeoutMs !== undefined ||
    (manifest.policy?.sandboxPackageGrants &&
      Object.keys(manifest.policy.sandboxPackageGrants).length > 0)
  ) {
    const p = manifest.policy;
    if (!p) return lines.join('\n');
    lines.push('# Package install/execution jail (ADR 0036)');
    lines.push('[sandbox]');
    if (p.sandboxMode === 'off') lines.push('enabled = false');
    else if (p.sandboxMode !== undefined) {
      lines.push('enabled = true');
      lines.push(`mode = ${tomlString(p.sandboxMode)}`);
    }
    if (p.sandboxPrefer !== undefined)
      lines.push(`prefer = ${tomlString(p.sandboxPrefer)}`);
    if (p.allowHostUnsandboxedInstall !== undefined)
      lines.push(
        `allow_host_unsandboxed_install = ${p.allowHostUnsandboxedInstall ? 'true' : 'false'}`,
      );
    const pe = p as PolicyInput & {
      projectWrite?: boolean;
      minimalPath?: boolean;
      strictLifecycleAllowlist?: boolean;
      allowDangerousGrants?: boolean;
      legacyFatRoot?: boolean;
      timeoutMs?: number;
    };
    if (pe.projectWrite !== undefined)
      lines.push(`project_write = ${pe.projectWrite ? 'true' : 'false'}`);
    if (pe.minimalPath !== undefined)
      lines.push(`minimal_path = ${pe.minimalPath ? 'true' : 'false'}`);
    if (pe.strictLifecycleAllowlist !== undefined)
      lines.push(
        `strict_lifecycle_allowlist = ${pe.strictLifecycleAllowlist ? 'true' : 'false'}`,
      );
    if (pe.allowDangerousGrants !== undefined)
      lines.push(
        `allow_dangerous_grants = ${pe.allowDangerousGrants ? 'true' : 'false'}`,
      );
    if (pe.legacyFatRoot !== undefined)
      lines.push(`legacy_fat_root = ${pe.legacyFatRoot ? 'true' : 'false'}`);
    if (pe.timeoutMs !== undefined) lines.push(`timeout_ms = ${pe.timeoutMs}`);
    lines.push('');
    for (const id of Object.keys(p.sandboxPackageGrants ?? {}).sort()) {
      const grant = p.sandboxPackageGrants![id]!;
      lines.push(`[sandbox.packages.${escapeKey(id)}]`);
      if (grant.network !== undefined)
        lines.push(`network = ${grant.network ? 'true' : 'false'}`);
      if (grant.write?.length)
        lines.push(`write = ${tomlStringArray(grant.write)}`);
      if (grant.read?.length)
        lines.push(`read = ${tomlStringArray(grant.read)}`);
      if (grant.env?.length) lines.push(`env = ${tomlStringArray(grant.env)}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

export function parseManifest(text: string): OpmManifest {
  const manifest = defaultManifest();
  let section: string | undefined;
  let packageAlias: string | undefined;
  const packageScratch = new Map<
    string,
    {
      purl?: string;
      version?: string;
      source?: string;
      bin_names?: string[];
      bin_paths?: string[];
      scope?: RequirementScope;
    }
  >();
  let registryId: string | undefined;
  const registryScratch = new Map<
    string,
    { url?: string; default_for?: string[] }
  >();
  let packProviderId: string | undefined;
  const packProviderScratch = new Map<
    string,
    {
      manifest?: string;
      executable?: string;
      default_for?: string[];
      allow_environment?: string[];
    }
  >();
  let pluginId: string | undefined;
  const pluginScratch = new Map<string, { store_digest?: string }>();
  const policyScratch: Record<string, string | boolean | number | string[]> =
    {};
  let hasPolicy = false;
  const sandboxScratch: Record<string, string | boolean | number | string[]> =
    {};
  let hasSandbox = false;
  let sandboxPackageId: string | undefined;
  const sandboxPackageScratch = new Map<
    string,
    {
      network?: boolean;
      write?: string[];
      read?: string[];
      env?: string[];
    }
  >();

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const line = stripComment(raw).trim();
    if (line === '') continue;

    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      const name = header[1] ?? '';
      if (name === 'project' || name === 'options' || name === 'policy') {
        section = name;
        packageAlias = undefined;
        sandboxPackageId = undefined;
        if (name === 'policy') hasPolicy = true;
      } else if (name === 'sandbox') {
        section = 'sandbox';
        packageAlias = undefined;
        sandboxPackageId = undefined;
        hasSandbox = true;
      } else if (name.startsWith('sandbox.packages.')) {
        section = 'sandbox-packages';
        packageAlias = undefined;
        // Keys may be quoted purls: sandbox.packages."pkg:npm/sharp"
        const rawKey = name.slice('sandbox.packages.'.length);
        sandboxPackageId = rawKey.replace(/^"(.*)"$/u, '$1');
        if (!sandboxPackageScratch.has(sandboxPackageId))
          sandboxPackageScratch.set(sandboxPackageId, {});
      } else if (name.startsWith('registries.')) {
        section = 'registries';
        registryId = name.slice('registries.'.length);
        packageAlias = undefined;
        sandboxPackageId = undefined;
        if (!registryScratch.has(registryId))
          registryScratch.set(registryId, {});
      } else if (name.startsWith('pack.providers.')) {
        section = 'pack-providers';
        packProviderId = name.slice('pack.providers.'.length);
        if (!PACK_PROVIDER_ID.test(packProviderId))
          throw new OpmError(
            'INVALID_MANIFEST',
            `Invalid pack provider id "${packProviderId}" at line ${i + 1}`,
          );
        packageAlias = undefined;
        sandboxPackageId = undefined;
        if (!packProviderScratch.has(packProviderId))
          packProviderScratch.set(packProviderId, {});
      } else if (name.startsWith('plugins.')) {
        section = 'plugins';
        // The key is the plugin's manifest id (e.g. dev.example.acme-adapter);
        // dotted ids work because the remainder is taken verbatim. Quoted
        // keys are unwrapped the same way sandbox package keys are.
        pluginId = name.slice('plugins.'.length).replace(/^"(.*)"$/u, '$1');
        if (!PLUGIN_ID.test(pluginId))
          throw new OpmError(
            'INVALID_MANIFEST',
            `Invalid plugin id "${pluginId}" at line ${i + 1}`,
          );
        packageAlias = undefined;
        sandboxPackageId = undefined;
        if (!pluginScratch.has(pluginId)) pluginScratch.set(pluginId, {});
      } else if (name.startsWith('packages.')) {
        section = 'packages';
        packageAlias = name.slice('packages.'.length);
        sandboxPackageId = undefined;
        if (!packageScratch.has(packageAlias))
          packageScratch.set(packageAlias, {});
      } else if (name === 'packages') {
        section = 'packages';
        packageAlias = undefined;
        sandboxPackageId = undefined;
      } else {
        throw new OpmError(
          'INVALID_MANIFEST',
          `Unsupported TOML section [${name}] at line ${i + 1}`,
        );
      }
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv) {
      throw new OpmError(
        'INVALID_MANIFEST',
        `Invalid TOML assignment at line ${i + 1}: ${raw}`,
      );
    }
    const key = kv[1] ?? '';
    const valueRaw = kv[2] ?? '';
    const value = parseTomlValue(valueRaw, i + 1);

    if (section === 'project') {
      if (key === 'name' && typeof value === 'string')
        manifest.project.name = value;
      else if (key === 'ecosystems' && Array.isArray(value))
        manifest.project.ecosystems = value;
      else
        throw new OpmError(
          'INVALID_MANIFEST',
          `Unknown project field "${key}" at line ${i + 1}`,
        );
    } else if (section === 'options') {
      if (key === 'offline' && typeof value === 'boolean')
        manifest.options.offline = value;
      else if (key === 'layout' && value === 'opm')
        manifest.options.layout = 'opm';
      else if (key === 'native_projection') {
        if (!isProjectionLevel(value))
          throw new OpmError(
            'INVALID_MANIFEST',
            `options.native_projection must be off|manifest|lock|layout (line ${i + 1})`,
          );
        manifest.options.nativeProjection = value;
      } else if (key === 'layout')
        throw new OpmError(
          'INVALID_MANIFEST',
          `Unsupported layout "${String(value)}" (v1 only supports "opm")`,
        );
      else
        throw new OpmError(
          'INVALID_MANIFEST',
          `Unknown options field "${key}" at line ${i + 1}`,
        );
    } else if (section === 'registries') {
      if (registryId === undefined)
        throw new OpmError(
          'INVALID_MANIFEST',
          `Registry field outside [registries.<id>] at line ${i + 1}`,
        );
      const scratch = registryScratch.get(registryId) ?? {};
      if (key === 'url' && typeof value === 'string') scratch.url = value;
      else if (key === 'default_for' && Array.isArray(value))
        scratch.default_for = value;
      else
        throw new OpmError(
          'INVALID_MANIFEST',
          `Unknown registry field "${key}" at line ${i + 1}`,
        );
      registryScratch.set(registryId, scratch);
    } else if (section === 'pack-providers') {
      if (packProviderId === undefined)
        throw new OpmError(
          'INVALID_MANIFEST',
          `Provider field outside [pack.providers.<id>] at line ${i + 1}`,
        );
      const scratch = packProviderScratch.get(packProviderId) ?? {};
      if (key === 'manifest' && typeof value === 'string')
        scratch.manifest = value;
      else if (key === 'executable' && typeof value === 'string')
        scratch.executable = value;
      else if (key === 'default_for' && Array.isArray(value))
        scratch.default_for = value;
      else if (key === 'allow_environment' && Array.isArray(value))
        scratch.allow_environment = value;
      else
        throw new OpmError(
          'INVALID_MANIFEST',
          `Unknown pack provider field "${key}" at line ${i + 1}`,
        );
      packProviderScratch.set(packProviderId, scratch);
    } else if (section === 'plugins') {
      if (pluginId === undefined)
        throw new OpmError(
          'INVALID_MANIFEST',
          `Plugin field outside [plugins.<id>] at line ${i + 1}`,
        );
      const scratch = pluginScratch.get(pluginId) ?? {};
      // A binding carries exactly one fact: which store entry is pinned. No
      // endpoints, no credentials — acquisition is never the manifest's job.
      if (key === 'store_digest' && typeof value === 'string')
        scratch.store_digest = value;
      else
        throw new OpmError(
          'INVALID_MANIFEST',
          `Unknown plugin field "${key}" at line ${i + 1}`,
        );
      pluginScratch.set(pluginId, scratch);
    } else if (section === 'policy') {
      // A misspelled policy key must not be a silently weaker policy. Every
      // other section rejects unknown fields; the governance section is the
      // last place to make an exception.
      if (!POLICY_KEYS.has(key))
        throw new OpmError(
          'INVALID_MANIFEST',
          `Unknown policy field "${key}" at line ${i + 1}. Known fields: ` +
            `${[...POLICY_KEYS].sort().join(', ')}`,
        );
      policyScratch[key] = value as string | boolean | number | string[];
    } else if (section === 'sandbox') {
      if (!SANDBOX_KEYS.has(key))
        throw new OpmError(
          'INVALID_MANIFEST',
          `Unknown sandbox field "${key}" at line ${i + 1}. Known fields: ` +
            `${[...SANDBOX_KEYS].sort().join(', ')}`,
        );
      sandboxScratch[key] = value as string | boolean | number | string[];
    } else if (section === 'sandbox-packages') {
      if (sandboxPackageId === undefined)
        throw new OpmError(
          'INVALID_MANIFEST',
          `Sandbox package field outside [sandbox.packages.<id>] at line ${i + 1}`,
        );
      const scratch = sandboxPackageScratch.get(sandboxPackageId) ?? {};
      if (key === 'network' && typeof value === 'boolean')
        scratch.network = value;
      else if (key === 'write' && Array.isArray(value)) scratch.write = value;
      else if (key === 'read' && Array.isArray(value)) scratch.read = value;
      else if (key === 'env' && Array.isArray(value)) scratch.env = value;
      else
        throw new OpmError(
          'INVALID_MANIFEST',
          `Unknown sandbox package field "${key}" at line ${i + 1}`,
        );
      sandboxPackageScratch.set(sandboxPackageId, scratch);
    } else if (section === 'packages') {
      if (packageAlias === undefined)
        throw new OpmError(
          'INVALID_MANIFEST',
          `Package field outside [packages.<alias>] at line ${i + 1}`,
        );
      const scratch = packageScratch.get(packageAlias) ?? {};
      if (key === 'purl' && typeof value === 'string') scratch.purl = value;
      else if (key === 'version' && typeof value === 'string')
        scratch.version = value;
      else if (key === 'source' && typeof value === 'string')
        scratch.source = value;
      else if (key === 'bin_names' && Array.isArray(value))
        scratch.bin_names = value;
      else if (key === 'bin_paths' && Array.isArray(value))
        scratch.bin_paths = value;
      else if (key === 'scope') {
        if (!isRequirementScope(value))
          throw new OpmError(
            'INVALID_MANIFEST',
            `packages.${packageAlias}.scope must be runtime|development|optional|peer|build (line ${i + 1})`,
          );
        scratch.scope = value;
      } else if (key === 'alias' && typeof value === 'string') {
        // ignore explicit alias; section key wins
      } else
        throw new OpmError(
          'INVALID_MANIFEST',
          `Unknown package field "${key}" at line ${i + 1}`,
        );
      packageScratch.set(packageAlias, scratch);
    } else {
      throw new OpmError(
        'INVALID_MANIFEST',
        `Assignment outside section at line ${i + 1}`,
      );
    }
  }

  for (const [alias, scratch] of packageScratch) {
    if (!scratch.purl) {
      throw new OpmError(
        'INVALID_MANIFEST',
        `Package "${alias}" is missing required purl`,
      );
    }
    const requirement: PackageRequirement = {
      alias,
      purl: scratch.purl,
    };
    if (scratch.version !== undefined) requirement.version = scratch.version;
    if (scratch.source !== undefined) requirement.source = scratch.source;
    if (scratch.scope !== undefined) requirement.scope = scratch.scope;
    if (scratch.bin_names !== undefined || scratch.bin_paths !== undefined) {
      const names = scratch.bin_names ?? [];
      const paths = scratch.bin_paths ?? [];
      if (names.length !== paths.length) {
        throw new OpmError(
          'INVALID_MANIFEST',
          `Package "${alias}" bin_names/bin_paths length mismatch`,
        );
      }
      requirement.bins = names.map((name, index) => ({
        name,
        path: paths[index] ?? '',
      }));
    }
    manifest.packages[alias] = requirement;
  }

  if (registryScratch.size > 0) {
    const registries: Record<string, RegistrySource> = {};
    for (const [id, scratch] of registryScratch) {
      if (!scratch.url)
        throw new OpmError(
          'INVALID_MANIFEST',
          `Registry "${id}" is missing required url`,
        );
      registries[id] = {
        id,
        url: scratch.url,
        ...(scratch.default_for === undefined
          ? {}
          : { defaultFor: scratch.default_for }),
      };
    }
    manifest.registries = registries;
  }

  if (packProviderScratch.size > 0) {
    const providers: Record<string, PackProviderSource> = {};
    for (const [id, scratch] of packProviderScratch) {
      if (!scratch.manifest)
        throw new OpmError(
          'INVALID_MANIFEST',
          `Pack provider "${id}" is missing required manifest`,
        );
      if (!scratch.executable)
        throw new OpmError(
          'INVALID_MANIFEST',
          `Pack provider "${id}" is missing required executable`,
        );
      providers[id] = {
        manifest: scratch.manifest,
        executable: scratch.executable,
        ...(scratch.default_for === undefined
          ? {}
          : { defaultFor: scratch.default_for }),
        ...(scratch.allow_environment === undefined
          ? {}
          : { allowEnvironment: scratch.allow_environment }),
      };
    }
    manifest.packProviders = providers;
  }

  if (pluginScratch.size > 0) {
    const plugins: Record<string, PluginBinding> = {};
    for (const [id, scratch] of pluginScratch) {
      if (!scratch.store_digest)
        throw new OpmError(
          'INVALID_MANIFEST',
          `Plugin "${id}" is missing required store_digest`,
        );
      plugins[id] = { storeDigest: assertDigest(scratch.store_digest) };
    }
    manifest.plugins = plugins;
  }

  if (hasPolicy) manifest.policy = policyFromScratch(policyScratch);

  if (hasSandbox || sandboxPackageScratch.size > 0) {
    const sandboxPolicy = sandboxFromScratch(
      sandboxScratch,
      sandboxPackageScratch,
    );
    manifest.policy = {
      ...(manifest.policy ?? {
        allowYanked: false,
        allowQuarantined: false,
        semanticLossMaximum: 'warning' as const,
        requiredEvidence: [],
      }),
      ...sandboxPolicy,
    };
  }

  return manifest;
}

/** Every field accepted under [policy], with the type it must have. */
const POLICY_FIELD_TYPES: Readonly<
  Record<string, 'boolean' | 'string' | 'number' | 'string[]'>
> = {
  allow_yanked: 'boolean',
  allow_quarantined: 'boolean',
  semantic_loss_maximum: 'string',
  required_evidence: 'string[]',
  minimum_release_age_minutes: 'number',
  minimum_release_age_strict: 'boolean',
  minimum_release_age_exclude: 'string[]',
  trust_policy: 'string',
  trust_policy_exclude: 'string[]',
  block_exotic_transitive: 'boolean',
  block_exotic_direct: 'boolean',
  allow_lifecycle_scripts: 'boolean',
  allowed_lifecycle_script_packages: 'string[]',
  expected_registry_id: 'string',
};

const POLICY_KEYS = new Set(Object.keys(POLICY_FIELD_TYPES));

const SANDBOX_FIELD_TYPES: Readonly<
  Record<string, 'boolean' | 'string' | 'number' | 'string[]'>
> = {
  enabled: 'boolean',
  mode: 'string',
  prefer: 'string',
  allow_host_unsandboxed_install: 'boolean',
  project_write: 'boolean',
  minimal_path: 'boolean',
  strict_lifecycle_allowlist: 'boolean',
  allow_dangerous_grants: 'boolean',
  legacy_fat_root: 'boolean',
  timeout_ms: 'number',
};

const SANDBOX_KEYS = new Set(Object.keys(SANDBOX_FIELD_TYPES));

function sandboxFromScratch(
  scratch: Record<string, string | boolean | number | string[]>,
  packages: Map<
    string,
    {
      network?: boolean;
      write?: string[];
      read?: string[];
      env?: string[];
    }
  >,
): Partial<PolicyInput> {
  for (const [key, value] of Object.entries(scratch)) {
    const expected = SANDBOX_FIELD_TYPES[key];
    if (expected === undefined)
      throw new OpmError('INVALID_MANIFEST', `Unknown sandbox field "${key}"`);
    const actual = Array.isArray(value) ? 'string[]' : typeof value;
    if (expected !== actual)
      throw new OpmError(
        'INVALID_MANIFEST',
        `sandbox.${key} must be ${expected}, got ${actual}`,
      );
  }

  const out: Partial<PolicyInput> = {};
  const enabled = scratch.enabled;
  const mode = scratch.mode;
  if (enabled === false) out.sandboxMode = 'off';
  else if (typeof mode === 'string') {
    if (mode !== 'fail-closed' && mode !== 'degrade-warn' && mode !== 'off')
      throw new OpmError(
        'INVALID_MANIFEST',
        'sandbox.mode must be fail-closed|degrade-warn|off',
      );
    out.sandboxMode = mode;
  } else if (enabled === true) {
    out.sandboxMode = 'fail-closed';
  }

  const prefer = scratch.prefer;
  if (typeof prefer === 'string') {
    if (prefer !== 'auto' && prefer !== 'mxc' && prefer !== 'native')
      throw new OpmError(
        'INVALID_MANIFEST',
        'sandbox.prefer must be auto|mxc|native',
      );
    out.sandboxPrefer = prefer;
  }

  if (typeof scratch.allow_host_unsandboxed_install === 'boolean')
    out.allowHostUnsandboxedInstall = scratch.allow_host_unsandboxed_install;

  if (out.sandboxMode === 'fail-closed') out.sandboxRequired = true;
  else if (out.sandboxMode === 'degrade-warn' || out.sandboxMode === 'off')
    out.sandboxRequired = false;

  // Extended knobs stored on PolicyInput via index signature until schema lands.
  const ext = out as Partial<PolicyInput> & Record<string, unknown>;
  if (typeof scratch.project_write === 'boolean')
    ext.projectWrite = scratch.project_write;
  if (typeof scratch.minimal_path === 'boolean')
    ext.minimalPath = scratch.minimal_path;
  if (typeof scratch.strict_lifecycle_allowlist === 'boolean')
    ext.strictLifecycleAllowlist = scratch.strict_lifecycle_allowlist;
  if (typeof scratch.allow_dangerous_grants === 'boolean')
    ext.allowDangerousGrants = scratch.allow_dangerous_grants;
  if (typeof scratch.legacy_fat_root === 'boolean')
    ext.legacyFatRoot = scratch.legacy_fat_root;
  if (typeof scratch.timeout_ms === 'number')
    ext.timeoutMs = scratch.timeout_ms;

  if (packages.size > 0) {
    const grants: NonNullable<PolicyInput['sandboxPackageGrants']> = {};
    for (const [id, g] of packages) {
      grants[id] = {
        ...(g.network === undefined ? {} : { network: g.network }),
        ...(g.write === undefined ? {} : { write: g.write }),
        ...(g.read === undefined ? {} : { read: g.read }),
        ...(g.env === undefined ? {} : { env: g.env }),
      };
    }
    out.sandboxPackageGrants = grants;
  }
  return out;
}

function policyFromScratch(
  scratch: Record<string, string | boolean | number | string[]>,
): PolicyInput {
  // A wrong-typed policy value is refused rather than dropped: silently
  // ignoring `minimum_release_age_minutes = "1440"` leaves the project running
  // with no release-age window while opm.toml says it has one.
  for (const [key, value] of Object.entries(scratch)) {
    const expected = POLICY_FIELD_TYPES[key];
    if (expected === undefined)
      throw new OpmError('INVALID_MANIFEST', `Unknown policy field "${key}"`);
    const actual = Array.isArray(value) ? 'string[]' : typeof value;
    if (expected !== actual)
      throw new OpmError(
        'INVALID_MANIFEST',
        `policy.${key} must be ${expected}, got ${actual}`,
      );
  }

  const bool = (key: string, fallback: boolean): boolean => {
    const value = scratch[key];
    return typeof value === 'boolean' ? value : fallback;
  };
  const str = (key: string): string | undefined => {
    const value = scratch[key];
    return typeof value === 'string' ? value : undefined;
  };
  const num = (key: string): number | undefined => {
    const value = scratch[key];
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : undefined;
  };
  const arr = (key: string): string[] | undefined => {
    const value = scratch[key];
    return Array.isArray(value) ? value : undefined;
  };

  const semantic = str('semantic_loss_maximum') ?? 'warning';
  if (semantic !== 'info' && semantic !== 'warning' && semantic !== 'error')
    throw new OpmError(
      'INVALID_MANIFEST',
      `policy.semantic_loss_maximum must be info|warning|error`,
    );

  const trust = str('trust_policy');
  if (trust !== undefined && trust !== 'none' && trust !== 'no-downgrade')
    throw new OpmError(
      'INVALID_MANIFEST',
      `policy.trust_policy must be none|no-downgrade`,
    );

  const policy: PolicyInput = {
    allowYanked: bool('allow_yanked', false),
    allowQuarantined: bool('allow_quarantined', false),
    semanticLossMaximum: semantic,
    requiredEvidence: arr('required_evidence') ?? [],
  };

  const age = num('minimum_release_age_minutes');
  if (age !== undefined) policy.minimumReleaseAgeMinutes = age;
  if (scratch.minimum_release_age_strict !== undefined)
    policy.minimumReleaseAgeStrict = bool('minimum_release_age_strict', false);
  const ageExclude = arr('minimum_release_age_exclude');
  if (ageExclude) policy.minimumReleaseAgeExclude = ageExclude;
  if (trust !== undefined) policy.trustPolicy = trust;
  const trustExclude = arr('trust_policy_exclude');
  if (trustExclude) policy.trustPolicyExclude = trustExclude;

  const blockTransitive = scratch.block_exotic_transitive;
  const blockDirect = scratch.block_exotic_direct;
  if (blockTransitive !== undefined || blockDirect !== undefined) {
    policy.blockExoticSources = {
      ...(typeof blockTransitive === 'boolean'
        ? { transitive: blockTransitive }
        : {}),
      ...(typeof blockDirect === 'boolean' ? { direct: blockDirect } : {}),
    };
  }
  if (scratch.allow_lifecycle_scripts !== undefined)
    policy.allowLifecycleScripts = bool('allow_lifecycle_scripts', false);
  const allowedScripts = arr('allowed_lifecycle_script_packages');
  if (allowedScripts) policy.allowedLifecycleScriptPackages = allowedScripts;
  const registryId = str('expected_registry_id');
  if (registryId !== undefined) {
    // Refuse secret-like env placeholders in committed registry pins (pnpm lesson).
    if (/\$\{[^}]+\}/.test(registryId))
      throw new OpmError(
        'INVALID_MANIFEST',
        'policy.expected_registry_id must not contain ${ENV} expansion (committed config cannot leak secrets via registry settings)',
      );
    policy.expectedRegistryId = registryId;
  }
  return policy;
}

function isRequirementScope(value: unknown): value is RequirementScope {
  return (
    value === 'runtime' ||
    value === 'development' ||
    value === 'optional' ||
    value === 'peer' ||
    value === 'build'
  );
}

function isProjectionLevel(value: unknown): value is NativeProjectionLevel {
  return (
    value === 'off' ||
    value === 'manifest' ||
    value === 'lock' ||
    value === 'layout'
  );
}

function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== '\\') inString = !inString;
    if (ch === '#' && !inString) return line.slice(0, i);
  }
  return line;
}

function parseTomlValue(
  raw: string,
  line: number,
): string | boolean | number | string[] {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) {
      throw new OpmError(
        'INVALID_MANIFEST',
        `Unterminated string at line ${line}`,
      );
    }
    return JSON.parse(value) as string;
  }
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) {
      throw new OpmError(
        'INVALID_MANIFEST',
        `Unterminated array at line ${line}`,
      );
    }
    const inner = value.slice(1, -1).trim();
    if (inner === '') return [];
    // split on commas not inside quotes
    const items: string[] = [];
    let current = '';
    let inString = false;
    for (let i = 0; i < inner.length; i += 1) {
      const ch = inner[i] ?? '';
      if (ch === '"' && inner[i - 1] !== '\\') inString = !inString;
      if (ch === ',' && !inString) {
        items.push(current.trim());
        current = '';
      } else current += ch;
    }
    items.push(current.trim());
    return items.map((item, index) => {
      if (!item.startsWith('"') || !item.endsWith('"')) {
        throw new OpmError(
          'INVALID_MANIFEST',
          `Array item ${index + 1} must be a string at line ${line}`,
        );
      }
      return JSON.parse(item) as string;
    });
  }
  // bare identifier (rare) — treat as string
  if (/^[A-Za-z0-9_./:@%+-]+$/.test(value)) return value;
  throw new OpmError(
    'INVALID_MANIFEST',
    `Unsupported TOML value at line ${line}: ${raw}`,
  );
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map((v) => tomlString(v)).join(', ')}]`;
}

function escapeKey(key: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(key)) return key;
  // quote-style section keys not supported; sanitize
  return key.replace(/[^A-Za-z0-9_-]/g, '_');
}

const PACK_PROVIDER_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/u;

// spec/prex/v1 DelegatedAdapterId: the same dotted-lowercase shape.
const PLUGIN_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/u;

function packProviderKey(id: string): string {
  if (!PACK_PROVIDER_ID.test(id))
    throw new OpmError('INVALID_MANIFEST', `Invalid pack provider id "${id}"`);
  return id;
}
